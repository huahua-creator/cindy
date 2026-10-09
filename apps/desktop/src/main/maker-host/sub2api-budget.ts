import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { storedCustomProviderId } from '@cindy/model-providers';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
  activeOwnerScopeKey,
} from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { broadcastMessageAgentMetaUpdate } from '../localDb/ipc/messages.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import {
  customProviderKeyGeneration,
  readCustomProviderKey,
} from '../secrets/providerSecretStore.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { getActiveCatalog } from './active-catalog.js';
import { getSessionProvider } from './session-provider-store.js';
import {
  getProviderRouteCredentialRevision,
  isProviderRouteMutationInProgress,
  providerRoutingForModel,
} from './provider-route.js';
import { outboundFetch } from './outbound-fetch.js';
import {
  normalizeBudgetURL,
  readBudgetJSON,
  responseIdentityParser,
  validateBudgetReceipt,
} from './sub2api-budget-protocol.js';
import {
  budgetUUID,
  type BudgetAttempt,
  type BudgetMutation,
  type BudgetMutationResult,
} from '../../shared/sub2apiBudget.js';

const log = createLogger('sub2api-budget');
// Process-local recovery only: never downgrade schema or rewrite saved connections.
const budgetServiceDisabled = process.argv.includes('--disable-sub2api-budget');
/** Read-only startup diagnostic, also used by the isolated packaged smoke. */
export function isBudgetReceiptRecoveryMode(): boolean {
  return budgetServiceDisabled;
}
interface Settings {
  connections: Array<{ providerId: string; responsesUrl: string }>;
}
const settings = createOverrideSettingsFile<Settings>({
  filePath: () => path.join(ownerScopedUserDataPath(), 'sub2api-budget-connections.json'),
  defaults: { connections: [] },
  scopeKey: activeOwnerScopeKey,
  log,
  label: 'sub2api-budget',
  maxBytes: 16384,
  logLoadedValue: false,
  logReadErrorDetails: false,
  normalize(raw) {
    const c = (raw as Settings | undefined)?.connections;
    return {
      connections: Array.isArray(c)
        ? c
            .slice(0, 8)
            .flatMap((v) =>
              typeof v?.providerId === 'string' &&
              v.providerId.length <= 128 &&
              normalizeBudgetURL(v.responsesUrl)
                ? [{ providerId: v.providerId, responsesUrl: normalizeBudgetURL(v.responsesUrl)! }]
                : [],
            )
        : [],
    };
  },
});

function scope() {
  if (budgetServiceDisabled) return null;
  const stopSignal = shutdown.signal;
  if (!app.isReady() || isAppSessionBoundaryPending() || stopSignal.aborted) return null;
  const owner = getActiveAppSession();
  const db = getCurrentDbClientSnapshot();
  if (!owner.dataOwnerId || !db) return null;
  const broadcast = captureDataOwnerBroadcastScope();
  const valid = () =>
    !stopSignal.aborted &&
    !isAppSessionBoundaryPending() &&
    getActiveAppSession().dataOwnerId === owner.dataOwnerId &&
    getActiveAppSession().generation === owner.generation &&
    getCurrentDbClientSnapshot() === db;
  return { db: db.client, ownerId: db.userId, valid, broadcast };
}
function connection(providerId: string) {
  if (isProviderRouteMutationInProgress(providerId)) return null;
  settings.invalidateIfChanged();
  const pin = settings.read().connections.find((c) => c.providerId === providerId);
  if (!pin) return null;
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  if (provider?.source !== 'user' || provider.auth.method !== 'apiKey') return null;
  const route = providerRoutingForModel(
    provider,
    'claude-code',
    provider.models['claude-code']?.[0]?.id ?? '',
  );
  if (!route || route.wireProtocol !== 'openai-responses') return null;
  const url = normalizeBudgetURL(
    `${route.upstream.replace(/\/+$/, '')}/${(route.requestPath ?? '/responses').replace(/^\/+/, '')}`,
  );
  if (url !== pin.responsesUrl) return null;
  const revision = getProviderRouteCredentialRevision(providerId);
  const key = readCustomProviderKey(storedCustomProviderId(providerId), 'claude-code');
  if (!key) return null;
  const generation = customProviderKeyGeneration(providerId, 'claude-code', key);
  if (
    !generation ||
    revision !== getProviderRouteCredentialRevision(providerId) ||
    isProviderRouteMutationInProgress(providerId)
  )
    return null;
  return { url, key, generation, revision };
}
export function captureBudgetMessageBinding(sessionId: string) {
  if (budgetServiceDisabled) return null;
  try {
    const s = scope();
    const providerId = getSessionProvider(sessionId);
    if (!s || !providerId) return null;
    const c = connection(providerId);
    if (!c || !s.valid()) return null;
    const valid = () =>
      s.valid() &&
      !isProviderRouteMutationInProgress(providerId) &&
      getProviderRouteCredentialRevision(providerId) === c.revision;
    return {
      ...s,
      sessionId,
      providerId,
      responsesUrl: c.url,
      credentialGeneration: c.generation,
      valid,
    };
  } catch {
    return null;
  }
}
type Binding = NonNullable<ReturnType<typeof captureBudgetMessageBinding>>;
type RequestBinding = Binding & { id: string; responseId: string };
const requestBindings = new Map<string, RequestBinding | null>();
const bindingKey = (owner: string, session: string, response: string) =>
  `${owner}\0${session}\0${response}`;
export function budgetBindingForMessage(
  sessionId: string,
  responseId: unknown,
): RequestBinding | null {
  const s = scope();
  if (!s || typeof responseId !== 'string') return null;
  const b = requestBindings.get(bindingKey(s.ownerId, sessionId, responseId));
  return b?.valid() ? b : null;
}

async function boundedObservation<T>(job: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      job,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 750);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mutate(
  s: NonNullable<ReturnType<typeof scope>>,
  a: BudgetMutation,
): Promise<BudgetMutationResult> {
  if (!s.valid()) return {};
  const { enqueueDurableWrite } = await import('../messagePersistBroadcaster.js');
  const result = await enqueueDurableWrite<BudgetMutationResult>('sub2api-budget', async () =>
    s.valid() ? s.db.tx('sub2apiBudget.mutate', a) : {},
  );
  if (s.valid() && result.sessionId && result.messageClientId)
    await broadcastMessageAgentMetaUpdate(result.sessionId, result.messageClientId, s.broadcast);
  return result;
}

export async function budgetMessagePersisted(binding: RequestBinding | null, clientId: string) {
  if (budgetServiceDisabled) return;
  if (!binding?.valid()) return;
  try {
    const result = await mutate(binding, {
      action: 'link',
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      id: binding.id,
      clientId,
      providerId: binding.providerId,
      responsesUrl: binding.responsesUrl,
      credentialGeneration: binding.credentialGeneration,
    });
    if (result.messageClientId)
      requestBindings.delete(bindingKey(binding.ownerId, binding.sessionId, binding.responseId));
    void pumpBudgetReceipts();
  } catch {
    log.warn('Budget message binding unavailable');
  }
}

/** Capture identity only for an explicitly pinned connection. The original body is preserved. */
export function withBudgetObservation(
  fetchImpl: typeof fetch,
  sessionId: string | undefined,
  providerId: string,
  url: string,
): typeof fetch {
  if (budgetServiceDisabled) return fetchImpl;
  return async (input, init) => {
    const binding = sessionId ? captureBudgetMessageBinding(sessionId) : null;
    const actual =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const sentKey = headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const enabled =
      binding?.providerId === providerId &&
      binding.responsesUrl === url &&
      actual === url &&
      !!sentKey &&
      customProviderKeyGeneration(providerId, 'claude-code', sentKey) ===
        binding.credentialGeneration;
    const response = await fetchImpl(input, init);
    if (!enabled || !binding?.valid() || !response.body) return response;
    const rawID = response.headers.get('x-client-request-id');
    const id = randomUUID();
    const now = Date.now();
    let observationActive = true;
    const observed = { ...binding, valid: () => observationActive && binding.valid() };
    const disable = () => {
      observationActive = false;
      void mutate(binding, {
        action: 'settle',
        ownerId: binding.ownerId,
        id,
        state: 'unavailable',
      }).catch(() => undefined);
    };
    try {
      const result = await boundedObservation(
        mutate(observed, {
          action: 'observe',
          row: {
            id,
            owner_id: binding.ownerId,
            session_id: binding.sessionId,
            provider_id: providerId,
            responses_url: url,
            credential_generation: binding.credentialGeneration,
            client_request_id: budgetUUID(rawID) ? rawID : null,
            response_id: null,
            message_client_id: null,
            state: 'pending',
            amount: null,
            attempts: 0,
            created_at: now,
            updated_at: now,
          },
        }),
      );
      if (!result?.id) {
        disable();
        return response;
      }
    } catch {
      log.warn('Budget request observation unavailable');
      return response;
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('event-stream')) {
      disable();
      return response;
    }
    let identified = false;
    const observe = responseIdentityParser(async (responseId) => {
      if (!observed.valid()) return;
      const result = await boundedObservation(
        mutate(observed, { action: 'identify', ownerId: binding.ownerId, id, responseId }),
      );
      if (!result?.id || !observed.valid()) {
        disable();
        return;
      }
      identified = true;
      const key = bindingKey(binding.ownerId, binding.sessionId, responseId);
      if (requestBindings.size >= 4096) requestBindings.clear();
      requestBindings.set(key, requestBindings.has(key) ? null : { ...binding, id, responseId });
    });
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const r = await reader.read();
          if (r.done) {
            if (!identified) disable();
            controller.close();
            return;
          }
          try {
            await observe(r.value);
          } catch {
            log.warn('Budget response identity unavailable');
          }
          controller.enqueue(r.value);
        } catch (e) {
          disable();
          controller.error(e);
        }
      },
      cancel(reason) {
        disable();
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

let running = false;
let interval: ReturnType<typeof setInterval> | undefined;
let shutdown = new AbortController();
const cooldowns = new Map<string, number>();
export function startBudgetReceiptRecovery(): () => void {
  if (budgetServiceDisabled) {
    log.warn('Budget receipt service disabled by startup recovery flag');
    return () => {};
  }
  if (!interval) {
    shutdown = new AbortController();
    interval = setInterval(() => void pumpBudgetReceipts(), 10000);
    interval.unref?.();
  }
  return () => {
    if (interval) clearInterval(interval);
    interval = undefined;
    shutdown.abort();
  };
}
async function pumpBudgetReceipts() {
  if (running || shutdown.signal.aborted) return;
  const s = scope();
  if (!s) return;
  running = true;
  try {
    await mutate(s, { action: 'cleanup', ownerId: s.ownerId, now: Date.now() });
    settings.invalidateIfChanged();
    if (!settings.read().connections.length) return;
    const rows = await s.db.query<BudgetAttempt>(
      `SELECT * FROM sub2api_budget_requests WHERE owner_id=? AND state='pending'
       AND (message_client_id IS NOT NULL OR (response_id IS NOT NULL AND created_at<=?))
       AND (attempts=0 OR updated_at<=?) ORDER BY created_at LIMIT 50`,
      [s.ownerId, Date.now() - 30000, Date.now() - 30000],
    );
    const deadline = Date.now() + 30000;
    for (const row of rows) {
      if (!s.valid() || shutdown.signal.aborted || Date.now() > deadline) break;
      const c = connection(row.provider_id);
      if (
        !c ||
        c.url !== row.responses_url ||
        c.generation !== row.credential_generation ||
        row.attempts >= 6 ||
        !budgetUUID(row.client_request_id) ||
        Date.now() - row.created_at > 30 * 86400000
      ) {
        await mutate(s, { action: 'settle', ownerId: s.ownerId, id: row.id, state: 'unavailable' });
        continue;
      }
      if ((cooldowns.get(c.url) ?? 0) > Date.now()) continue;
      if (!row.message_client_id) {
        const linked = await mutate(s, {
          action: 'link',
          ownerId: s.ownerId,
          id: row.id,
          sessionId: row.session_id,
          providerId: row.provider_id,
          responsesUrl: row.responses_url,
          credentialGeneration: row.credential_generation,
        });
        if (!linked.messageClientId) continue;
      }
      const claim = await mutate(s, { action: 'attempt', ownerId: s.ownerId, id: row.id });
      if (!claim.allowed || !s.valid()) continue;
      const valid = () => {
        if (!s.valid()) return false;
        const current = connection(row.provider_id);
        return (
          !!current &&
          current.url === row.responses_url &&
          current.generation === row.credential_generation &&
          current.revision === c.revision
        );
      };
      if (!valid()) continue;
      try {
        const response = await outboundFetch(
          new URL(`/v1/sub2api/billing/receipt/${row.client_request_id}`, c.url).href,
          {
            headers: { Authorization: `Bearer ${c.key}` },
            redirect: 'error',
            signal: AbortSignal.any([AbortSignal.timeout(3000), shutdown.signal]),
          },
        );
        if (!valid()) {
          await response.body?.cancel();
          continue;
        }
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const seconds = retry === null ? 1 : Number(retry);
          await response.body?.cancel();
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)
            await mutate(s, {
              action: 'settle',
              ownerId: s.ownerId,
              id: row.id,
              state: 'unavailable',
            });
          else {
            if (cooldowns.size >= 64) cooldowns.clear();
            cooldowns.set(c.url, Date.now() + Math.max(1, seconds) * 1000);
          }
          break;
        }
        if (response.status === 404 || response.status >= 500) {
          await response.body?.cancel();
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          await mutate(s, {
            action: 'settle',
            ownerId: s.ownerId,
            id: row.id,
            state: 'unavailable',
          });
          continue;
        }
        const amount = validateBudgetReceipt(await readBudgetJSON(response), row.client_request_id);
        if (valid())
          await mutate(
            { ...s, valid },
            {
              action: 'settle',
              ownerId: s.ownerId,
              id: row.id,
              state: amount === null ? 'unavailable' : 'complete',
              expected: {
                sessionId: row.session_id,
                providerId: row.provider_id,
                responsesUrl: row.responses_url,
                credentialGeneration: row.credential_generation,
                clientRequestId: row.client_request_id,
              },
              ...(amount === null ? {} : { amount }),
            },
          );
      } catch {
        /* Bounded persisted retry; never substitute zero or the SDK estimate. */
      }
    }
  } catch {
    log.warn('Budget receipt recovery unavailable');
  } finally {
    running = false;
  }
}
