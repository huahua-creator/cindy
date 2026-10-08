import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sub2apiBudgetMutation } from '../../localDb/worker/opHandlers/sub2apiBudgetTx';

const mocks = vi.hoisted(() => ({
  owner: { dataOwnerId: 'u', generation: 1 },
  snapshot: null as any,
  generation: 'a'.repeat(64),
  revision: 0,
  enabled: true,
  key: 'test-key',
  queue: Promise.resolve() as Promise<any>,
  queued: 0,
  fetch: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isReady: () => true } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ ...mocks.owner }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/unused',
  activeOwnerScopeKey: () => String(mocks.owner.generation),
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientSnapshot: () => mocks.snapshot,
}));
vi.mock('../../localDb/ipc/messages', () => ({ broadcastMessageAgentMetaUpdate: mocks.broadcast }));
vi.mock('../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerId: mocks.owner.dataOwnerId }),
}));
vi.mock('../../messagePersistBroadcaster', () => ({
  enqueueDurableWrite: (_name: string, job: () => Promise<any>) => {
    mocks.queued++;
    const p = mocks.queue.then(job);
    mocks.queue = p.catch(() => undefined);
    return p;
  },
}));
vi.mock('../../secrets/providerSecretStore', () => ({
  readCustomProviderKey: () => mocks.key,
  customProviderKeyGeneration: (_p: string, _a: string, key: string) =>
    key === mocks.key ? mocks.generation : null,
}));
vi.mock('../override-settings-file', () => ({
  createOverrideSettingsFile: () => ({
    invalidateIfChanged: () => {},
    read: () => ({
      connections: mocks.enabled
        ? [{ providerId: 'p', responsesUrl: 'http://127.0.0.1:18080/v1/responses' }]
        : [],
    }),
  }),
}));
vi.mock('../active-catalog', () => ({
  getActiveCatalog: () => ({
    providers: [
      {
        id: 'p',
        source: 'user',
        auth: { method: 'apiKey' },
        models: { 'claude-code': [{ id: 'gpt-6-astra' }] },
      },
    ],
  }),
}));
vi.mock('../session-provider-store', () => ({ getSessionProvider: () => 'p' }));
vi.mock('../provider-route', () => ({
  getProviderRouteCredentialRevision: () => mocks.revision,
  isProviderRouteMutationInProgress: () => false,
  providerRoutingForModel: () => ({
    upstream: 'http://127.0.0.1:18080/v1',
    wireProtocol: 'openai-responses',
  }),
}));
vi.mock('../outbound-fetch', () => ({ outboundFetch: mocks.fetch }));

import {
  budgetBindingForMessage,
  budgetMessagePersisted,
  startBudgetReceiptRecovery,
  withBudgetObservation,
} from '../sub2api-budget';
const uuid = 'dd0d39a6-9dfd-493b-a4e2-bc6f95dd9a98';
const url = 'http://127.0.0.1:18080/v1/responses';
let db: Database.Database;
let stop: () => void;
let sequence = 0;
let sid: string;
let rid: string;
function receipt() {
  return new Response(
    JSON.stringify({
      schema_version: 1,
      kind: 'subscription-budget',
      currency: 'USD',
      amount: '0.98506000',
      client_request_id: uuid,
      settled_at: new Date().toISOString(),
    }),
  );
}
function event() {
  return `data: ${JSON.stringify({ type: 'response.created', response: { id: rid } })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'original reply' })}\n\n`;
}
function upstream() {
  return new Response(event(), {
    headers: { 'content-type': 'text/event-stream', 'x-client-request-id': uuid },
  });
}
async function observe() {
  const original = upstream();
  const wrapped = withBudgetObservation(async () => original, sid, 'p', url);
  return wrapped(url, { headers: { Authorization: 'Bearer test-key' } });
}
function addMessage() {
  db.prepare(
    "INSERT INTO messages(session_id,client_id,role,agent_meta,created_at) VALUES(?,'m','assistant',?,?)",
  ).run(sid, JSON.stringify({ requestId: rid, turnCostUsd: 0.49253 }), Date.now());
}
function meta() {
  const r = db.prepare("SELECT agent_meta FROM messages WHERE client_id='m'").get() as {
    agent_meta: string;
  };
  return JSON.parse(r.agent_meta);
}
beforeEach(() => {
  sequence++;
  sid = `session-${sequence}`;
  rid = `resp_${sequence}`;
  mocks.owner = { dataOwnerId: 'u', generation: sequence };
  mocks.generation = 'a'.repeat(64);
  mocks.revision = 0;
  mocks.enabled = true;
  mocks.key = 'test-key';
  mocks.queue = Promise.resolve();
  mocks.queued = 0;
  mocks.fetch.mockReset().mockImplementation(async () => receipt());
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE sessions(id TEXT PRIMARY KEY,cleared_at INTEGER);CREATE TABLE messages(session_id TEXT,client_id TEXT,role TEXT,agent_meta TEXT,created_at INTEGER,rewind_at INTEGER);',
  );
  db.prepare('INSERT INTO sessions(id) VALUES(?)').run(sid);
  db.exec(
    readFileSync(
      resolve(__dirname, '../../../../drizzle/0123_sub2api_budget_requests.sql'),
      'utf8',
    ),
  );
  db.exec(
    readFileSync(
      resolve(__dirname, '../../../../drizzle/0124_sub2api_budget_watermark.sql'),
      'utf8',
    ),
  );
  mocks.snapshot = {
    userId: 'u',
    clientEpoch: sequence,
    client: {
      query: async (sql: string, args: unknown[]) => db.prepare(sql).all(...args),
      tx: async (_name: string, arg: unknown) => sub2apiBudgetMutation(db, arg),
    },
  };
  stop = startBudgetReceiptRecovery();
});
afterEach(async () => {
  stop();
  await mocks.queue;
  vi.useRealTimers();
  db.close();
});

describe('budget observation and owner boundaries', () => {
  it.each(['credential', 'opt-in'] as const)(
    'rechecks %s after a receipt waits in the durable queue',
    async (change) => {
      let release!: () => void;
      const pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      let queuedBeforeSettle = 0;
      mocks.fetch.mockImplementation(async () => {
        queuedBeforeSettle = mocks.queued;
        mocks.queue = pause;
        return receipt();
      });
      await (await observe()).text();
      addMessage();
      await budgetMessagePersisted(budgetBindingForMessage(sid, rid), 'm');
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(mocks.queued).toBeGreaterThan(queuedBeforeSettle));
      if (change === 'credential') {
        mocks.generation = 'b'.repeat(64);
        mocks.revision++;
      } else mocks.enabled = false;
      release();
      await mocks.queue;
      expect(meta().sub2apiBudget).toEqual({ state: 'pending' });
    },
  );
  it('keeps response bytes and IDs unchanged and projects a verified request budget', async () => {
    const response = await observe();
    expect(await response.text()).toBe(event());
    const binding = budgetBindingForMessage(sid, rid);
    expect(binding).not.toBeNull();
    addMessage();
    await budgetMessagePersisted(binding, 'm');
    await vi.waitFor(() =>
      expect(meta().sub2apiBudget).toEqual({ state: 'complete', amount: '0.98506000' }),
    );
    expect(meta().turnCostUsd).toBe(0.49253);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:18080/v1/sub2api/billing/receipt/${uuid}`,
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  it('does not observe unapproved connections', async () => {
    mocks.enabled = false;
    const response = await observe();
    expect(await response.text()).toBe(event());
    expect(budgetBindingForMessage(sid, rid)).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('does not bind a request after owner or credential change', async () => {
    expect(await (await observe()).text()).toBe(event());
    mocks.revision++;
    expect(budgetBindingForMessage(sid, rid)).toBeNull();
    mocks.owner.generation++;
    expect(budgetBindingForMessage(sid, rid)).toBeNull();
  });
  it('forwards a reply after slow database timeout and refuses late binding', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pause = new Promise<void>((r) => {
      release = r;
    });
    const normal = mocks.snapshot.client.tx;
    mocks.snapshot.client.tx = async (n: string, a: any) => {
      if (a.action === 'observe') await pause;
      return normal(n, a);
    };
    const pending = observe();
    await vi.advanceTimersByTimeAsync(800);
    const response = await pending;
    expect(await response.text()).toBe(event());
    expect(budgetBindingForMessage(sid, rid)).toBeNull();
    release();
    await mocks.queue;
    expect(budgetBindingForMessage(sid, rid)).toBeNull();
    const row = db
      .prepare('SELECT state,message_client_id FROM sub2api_budget_requests')
      .get() as any;
    expect(row).toMatchObject({ state: 'unavailable', message_client_id: null });
  });
  it('leaves a missing receipt pending instead of inventing a zero', async () => {
    mocks.fetch.mockImplementation(async () => new Response('', { status: 404 }));
    await (await observe()).text();
    addMessage();
    await budgetMessagePersisted(budgetBindingForMessage(sid, rid), 'm');
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(meta().sub2apiBudget).toEqual({ state: 'pending' });
  });
  it('does not apply a receipt returned after an owner switch', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    mocks.fetch.mockImplementation(async () => {
      await pending;
      return receipt();
    });
    await (await observe()).text();
    addMessage();
    await budgetMessagePersisted(budgetBindingForMessage(sid, rid), 'm');
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    mocks.owner.generation++;
    release();
    await new Promise((r) => setTimeout(r, 20));
    await mocks.queue;
    expect(meta().sub2apiBudget).toEqual({ state: 'pending' });
  });
  it('does not apply a receipt after the credential generation changes', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    mocks.fetch.mockImplementation(async () => {
      await pending;
      return receipt();
    });
    await (await observe()).text();
    addMessage();
    await budgetMessagePersisted(budgetBindingForMessage(sid, rid), 'm');
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    mocks.generation = 'b'.repeat(64);
    mocks.revision++;
    release();
    await new Promise((r) => setTimeout(r, 20));
    await mocks.queue;
    expect(meta().sub2apiBudget).toEqual({ state: 'pending' });
  });
  it('propagates cancellation without creating a budget value', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'text/event-stream', 'x-client-request-id': uuid },
    });
    const wrapped = withBudgetObservation(async () => response, sid, 'p', url);
    const observed = await wrapped(url, { headers: { Authorization: 'Bearer test-key' } });
    await observed.body!.cancel('stop');
    await vi.waitFor(() =>
      expect((db.prepare('SELECT state FROM sub2api_budget_requests').get() as any).state).toBe(
        'unavailable',
      ),
    );
    expect(cancel).toHaveBeenCalledWith('stop');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('recovers the message-commit to link crash window after restart', async () => {
    await (await observe()).text();
    addMessage();
    stop();
    mocks.owner.generation++;
    mocks.snapshot = { ...mocks.snapshot, clientEpoch: 999 };
    db.exec(`UPDATE sub2api_budget_requests SET created_at=created_at-60000,updated_at=1`);
    vi.useFakeTimers();
    stop = startBudgetReceiptRecovery();
    await vi.advanceTimersByTimeAsync(10000);
    await mocks.queue;
    expect(meta().sub2apiBudget).toEqual({ state: 'complete', amount: '0.98506000' });
  });
  it.each(['non-sse', 'empty-eof', 'stream-error'])(
    'terminates %s orphan observation',
    async (kind) => {
      const response =
        kind === 'stream-error'
          ? new Response(
              new ReadableStream({
                pull(c) {
                  c.error(Error('stream'));
                },
              }),
              { headers: { 'content-type': 'text/event-stream', 'x-client-request-id': uuid } },
            )
          : new Response(kind === 'non-sse' ? '{}' : 'data: {}\n\n', {
              headers: {
                'content-type': kind === 'non-sse' ? 'application/json' : 'text/event-stream',
                'x-client-request-id': uuid,
              },
            });
      const wrapped = withBudgetObservation(async () => response, sid, 'p', url);
      const result = await wrapped(url, { headers: { Authorization: 'Bearer test-key' } });
      await result.text().catch(() => undefined);
      await mocks.queue;
      expect((db.prepare('SELECT state FROM sub2api_budget_requests').get() as any).state).toBe(
        'unavailable',
      );
    },
  );
  it('recovers persisted bound pending work with the same owner and credential', async () => {
    mocks.fetch.mockImplementation(async () => new Response('', { status: 404 }));
    await (await observe()).text();
    addMessage();
    await budgetMessagePersisted(budgetBindingForMessage(sid, rid), 'm');
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    stop();
    mocks.owner.generation++;
    mocks.snapshot = { ...mocks.snapshot, clientEpoch: 999 };
    db.exec('UPDATE sub2api_budget_requests SET updated_at=1');
    mocks.fetch.mockImplementation(async () => receipt());
    vi.useFakeTimers();
    stop = startBudgetReceiptRecovery();
    await vi.advanceTimersByTimeAsync(10000);
    await mocks.queue;
    expect(meta().sub2apiBudget).toEqual({ state: 'complete', amount: '0.98506000' });
  });
});
