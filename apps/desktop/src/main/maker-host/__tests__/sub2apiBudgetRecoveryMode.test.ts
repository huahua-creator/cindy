import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ready: vi.fn(() => true), owner: vi.fn(() => ({ dataOwnerId: 'u', generation: 1 })),
  snapshot: vi.fn(() => null), path: vi.fn(), scope: vi.fn(), boundary: vi.fn(() => false),
  settingsRead: vi.fn(), invalidate: vi.fn(), secret: vi.fn(), keyGeneration: vi.fn(),
  tx: vi.fn(), query: vi.fn(), queue: vi.fn(), receiptFetch: vi.fn(),
  provider: vi.fn(), catalog: vi.fn(), route: vi.fn(), revision: vi.fn(), mutation: vi.fn(),
  broadcast: vi.fn(), broadcastScope: vi.fn(), warn: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isReady: m.ready } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: m.owner, isAppSessionBoundaryPending: m.boundary,
  ownerScopedUserDataPath: m.path, activeOwnerScopeKey: m.scope,
}));
vi.mock('../../localDb/client/current', () => ({ getCurrentDbClientSnapshot: m.snapshot }));
vi.mock('../../localDb/ipc/messages', () => ({ broadcastMessageAgentMetaUpdate: m.broadcast }));
vi.mock('../../device-link/broadcast-tap', () => ({ captureDataOwnerBroadcastScope: m.broadcastScope }));
vi.mock('../../secrets/providerSecretStore', () => ({
  readCustomProviderKey: m.secret, customProviderKeyGeneration: m.keyGeneration,
}));
vi.mock('../../messagePersistBroadcaster', () => ({ enqueueDurableWrite: m.queue }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: m.warn }) }));
vi.mock('../override-settings-file', () => ({ createOverrideSettingsFile: () => ({
  read: m.settingsRead, invalidateIfChanged: m.invalidate,
}) }));
vi.mock('../active-catalog', () => ({ getActiveCatalog: m.catalog }));
vi.mock('../session-provider-store', () => ({ getSessionProvider: m.provider }));
vi.mock('../provider-route', () => ({
  getProviderRouteCredentialRevision: m.revision, isProviderRouteMutationInProgress: m.mutation,
  providerRoutingForModel: m.route,
}));
vi.mock('../outbound-fetch', () => ({ outboundFetch: m.receiptFetch }));

const originalArgv = [...process.argv];
const flag = '--disable-sub2api-budget';
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { process.argv = [...originalArgv]; vi.restoreAllMocks(); vi.useRealTimers(); });

async function load(args: string[]) {
  process.argv = [originalArgv[0], originalArgv[1], ...args];
  return import('../sub2api-budget');
}

describe('process-local budget receipt recovery mode', () => {
  it('bypasses all receipt dependencies and preserves the original request/response stream', async () => {
    const api = await load([flag]);
    process.argv = [...originalArgv]; // A mutable argv cannot re-enable this process.
    expect(api.isBudgetReceiptRecoveryMode()).toBe(true);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const raw = new Response('data: synthetic\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(raw);
    const wrapped = api.withBudgetObservation(upstream, 's', 'p', 'http://127.0.0.1/responses');
    expect(wrapped).toBe(upstream);
    const request = new Request('http://127.0.0.1/responses', { method: 'POST', body: 'synthetic' });
    const init = { headers: { 'x-test': 'synthetic' } };
    const response = await wrapped(request, init);
    expect(upstream).toHaveBeenCalledExactlyOnceWith(request, init);
    expect(response).toBe(raw);
    expect(await response.text()).toBe('data: synthetic\n\n');
    expect(api.captureBudgetMessageBinding('s')).toBeNull();
    expect(api.budgetBindingForMessage('s', 'r')).toBeNull();
    const valid = vi.fn(() => true);
    await api.budgetMessagePersisted({ valid, db: { tx: m.tx, query: m.query } } as never, 'm');
    const stop = api.startBudgetReceiptRecovery();
    stop(); stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(interval).not.toHaveBeenCalled();
    expect(valid).not.toHaveBeenCalled();
    for (const [name, mock] of Object.entries(m)) {
      if (name !== 'warn') expect(mock, name).not.toHaveBeenCalled();
    }
    expect(m.warn).toHaveBeenCalledWith('Budget receipt service disabled by startup recovery flag');
  });

  it.each([
    { label: 'absent', args: [] },
    { label: 'value suffix', args: [flag + '=true'] },
    { label: 'near match', args: [flag + '-extra'] },
  ])('leaves ordinary behavior intact for $label', async ({ args }) => {
    const api = await load(args);
    process.argv.push(flag); // Import-time choice cannot be changed in a live process.
    expect(api.isBudgetReceiptRecoveryMode()).toBe(false);
    const upstream = vi.fn<typeof fetch>();
    expect(api.withBudgetObservation(upstream, 's', 'p', 'http://127.0.0.1/responses')).not.toBe(upstream);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const stop = api.startBudgetReceiptRecovery();
    expect(interval).toHaveBeenCalledOnce();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
