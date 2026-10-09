import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { Session, type AgentSessionHandle } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import { snapshotHandoffRuntime, sameHandoffRuntimeRoute, handoffMcpSourceFingerprint, readHandoffMcpProfile } from '../handoffMcpProfile';
import { withCreateSessionStderr } from '../sessionRequest';

// Execute the production create function with isolated ports. No Electron/DB/model is started.
const source = readFileSync(resolve(__dirname, '../register.ts'), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.Latest, true);
let declaration: string | undefined;
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'sendToSessionInternal') declaration = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!declaration) throw new Error('Production sendToSessionInternal not found');
const body = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const adapterSource = readFileSync(resolve(__dirname, '../../mcp-integrations/mcp-providers.ts'), 'utf8');
const adapterAst = ts.createSourceFile('mcp-providers.ts', adapterSource, ts.ScriptTarget.Latest, true);
let adapterDeclaration: string | undefined;
function findAdapter(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(adapterAst) === 'sendToSession'
    && ts.isArrowFunction(node.initializer) && node.initializer.getText(adapterAst).includes('hasExecutionOverrides')) {
    adapterDeclaration = node.initializer.getText(adapterAst);
  }
  ts.forEachChild(node, findAdapter);
}
findAdapter(adapterAst);
if (!adapterDeclaration) throw new Error('Production MCP handoff adapter not found');
const adapterBody = ts.transpileModule(`const adapter = ${adapterDeclaration};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(realSession = false) {
  const sessions = { id: 'session-id' };
  const botSessionLinks = { sessionId: 'bot-session-id' };
  const makeLive = (id: string, plan: boolean) => ({ id, instanceId: `${id}-instance`, agentKind: 'claude-code',
    model: 'test-model', workDir: 'C:/test', status: 'active', turn: 0, running: false, sdkSessionId: '<pending>',
    stablePermissionModeState: { mode: 'ask', generation: 1 }, stablePlanModeState: { enabled: plan, generation: 1 },
    getStatus() { return this.status; }, hasStartedClosing: () => false,
    getTurnGeneration() { return this.turn; }, isTurnRunning() { return this.running; } });
  const vendorSend = vi.fn(async () => {});
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const handle: AgentSessionHandle = {
    id: '<pending>', agentKind: 'claude-code', model: 'test-model', send: vendorSend,
    async steer() {}, async abort() {}, async close() {}, async setPlanMode() {}, getPlanMode: () => true,
    async *events() { await new Promise<never>(() => {}); },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {}, isTurnRunning: () => false,
  };
  const child: any = realSession ? new Session({ id: 'child', agentKind: 'claude-code', workDir: 'C:/test',
    permissionMode: 'ask', handle, logger, turnStallMs: 0,
    capabilities: { planMode: { supported: true }, availableModels: [], effortLevels: [], permissionModes: [],
      switchModel: { supported: false, reason: 'not-implemented' }, hasFastMode: false,
      effort: { supported: false, reason: 'not-implemented' }, reasoningDisplay: [],
      setPermissionModeMidSession: { supported: false, reason: 'not-implemented' },
      multimodal: { text: { supported: true }, image: { supported: false, reason: 'not-implemented' },
        file: { supported: false, reason: 'not-implemented' } },
      memory: { supported: { supported: false, reason: 'not-implemented' } },
      fork: { supported: false, reason: 'not-implemented' }, rewind: { supported: false, reason: 'not-implemented' },
      extraDirs: { supported: false, reason: 'not-implemented' }, abort: { supported: true },
      sameTurnSteer: { supported: false, reason: 'not-implemented' } },
  }) : makeLive('child', true);
  const state = {
    row: { status: 'active', source: 'desktop', agentKind: 'cc', remoteHostId: null, orcaRole: null,
      model: 'test-model', providerId: 'test-provider', effort: 'low', fastMode: false,
      workingDir: 'C:/test', workspaceKind: 'project', permissionMode: 'ask', planModeEnabled: false } as Record<string, unknown> | undefined,
    meta: { agentKind: 'claude-code', model: 'test-model', workDir: 'C:/test', remoteHostId: null as string | null },
    linked: false, live: makeLive('source', false) as any, childCurrent: undefined as any,
    childRow: undefined as Record<string, unknown> | undefined,
    owner: {} as object, scope: 1, pending: false, revision: 1,
    controls: { source: { generation: 0, pending: null as unknown }, child: { generation: 0, pending: null as unknown } },
    routes: { source: { provider: 'test-provider', effort: 'low', fast: false }, child: { provider: 'test-provider', effort: 'low', fast: false } },
    beforeCommit: (() => {}) as () => void, afterAccepted: (() => {}) as () => void,
    afterCapture: (() => {}) as () => void, beforeBootstrap: (() => {}) as () => void,
    duringClose: (() => {}) as () => void,
    admittedPatch: {} as Record<string, unknown>,
  };
  const query = vi.fn((table: object, id: string) => Promise.resolve(table === sessions
    ? (id === 'source' ? state.row : state.childRow) ? [{ ...(id === 'source' ? state.row : state.childRow) }] : []
    : state.linked ? [{ sessionId: 'source' }] : []));
  const insert = vi.fn(async (row: any) => { state.childRow = { ...row }; });
  const db = { select: () => ({ from: (table: object) => ({ where: (condition: { id: string }) => ({ limit: () => query(table, condition.id) }) }) }),
    insert: () => ({ values: (row: any) => ({ run: () => insert(row) }) }) };
  const bootstrap = vi.fn(async (_opts: any, assertCurrent?: () => void, capture?: (s: any) => void) => {
    state.beforeBootstrap(); assertCurrent?.(); if (realSession) await child.setPlanMode(true); state.childCurrent = child; capture?.(child); state.afterCapture(); return { session: child };
  });
  const open = vi.fn(async (input: any, commit: (row: any, current: () => void) => Promise<unknown>) => {
    state.beforeCommit(); input.assertCurrent?.();
    const row = { status: 'active', ...input.body, id: 'child', ...state.admittedPatch };
    const value = await commit(row, () => input.assertCurrent?.()); return { row, value };
  });
  const dispatch = vi.fn();
  const send = vi.fn(async (_session: unknown, _message: string, _clientId: string, opts: any) => {
    if (realSession) return child.send(_message, { ...opts, onAccepted: async () => {
      await opts.onAccepted?.(); state.afterAccepted();
    } });
    child.running = true;
    const previousTurn = child.turn;
    try {
      opts.onTurnReserved?.(++child.turn); await opts.beforeProviderStart?.();
      await opts.onAccepted?.(); state.afterAccepted(); await opts.beforeVendorDispatch?.();
      opts.onDispatching?.(); dispatch(); return { accepted: true };
    } catch (error) {
      if (child.turn === previousTurn + 1) child.turn = previousTurn;
      throw error;
    } finally { child.running = false; }
  });
  const close = vi.fn(async (target: any) => {
    if (state.childCurrent !== target) return 'not-current';
    state.duringClose(); if (realSession) await target.close(); else target.status = 'closed'; state.childCurrent = undefined; return 'closed';
  });
  const worktree = vi.fn(); const readIdentity = vi.fn(async () => ({})); const message = vi.fn(); const rollback = vi.fn();
  const dependencies = {
    readHandoffMcpProfile, snapshotHandoffRuntime, sameHandoffRuntimeRoute, handoffMcpSourceFingerprint,
    getCurrentDbClientSnapshot: () => state.owner, getActiveAppSession: () => ({ generation: state.scope }),
    isAppSessionBoundaryPending: () => state.pending,
    getSessionRuntimeControlSnapshot: (id: 'source' | 'child') => state.controls[id],
    getSessionProvider: (id: 'source' | 'child') => state.routes[id].provider,
    getSessionEffort: (id: 'source' | 'child') => state.routes[id].effort,
    getSessionFastMode: (id: 'source' | 'child') => state.routes[id].fast,
    getProviderRouteCredentialRevision: () => state.revision,
    sessionQueueOriginForDispatcher: () => undefined, readSenderIdentity: readIdentity,
    getDbClient: () => ({ drizzle: db }), sessions, botSessionLinks, eq: (_column: unknown, id: string) => ({ id }),
    maker: { getSessionMeta: async () => state.meta, getSession: (id: string) => id === 'source' ? state.live : state.childCurrent,
      closeSessionIfCurrent: close },
    permissionModeOrAsk: (value: string) => value ?? 'ask',
    buildCreateOptsWithStderr: (opts: any) => withCreateSessionStderr(opts, vi.fn()),
    openSession: open, bootstrapSession: bootstrap, sendUserMessageWithAwaitedGitBaseline: send,
    prepareHandoffWorktree: worktree, createId: () => 'message',
    notifyAgentIslandUserPrompt: vi.fn(), createDbMessage: message, broadcastSessionCreated: vi.fn(),
    dispatchAgentIslandUserPrompt: vi.fn(), commitAgentIslandUserPrompt: vi.fn(), rollbackAgentIslandUserPrompt: rollback,
    assertDesktopSendDispatched: (result: any) => { if (!result.accepted) throw new Error('not accepted'); },
    isSessionRunningError: () => false, log: { info: vi.fn(), warn: vi.fn() },
  };
  const run = new Function(...Object.keys(dependencies), `${body}; return sendToSessionInternal;`)(...Object.values(dependencies));
  const fromMcp = new Function('tryGetOrcaCollabService', `${adapterBody}; return adapter;`)(() => ({ sendToSession: run }));
  return { state, child, vendorSend, rollback, run, fromMcp, bootstrap, open, send, dispatch, close, insert, message, worktree, readIdentity, query };
}

describe('handoff diagnostic MCP profile production path', () => {
  it.each([{ names: [] }, { names: ['wwise-mcp', 'wwise-mcp'] }])('inherits route with fixed ask and Plan for explicit $names', async ({ names }) => {
    const h = harness();
    h.state.row!.permissionMode = 'acceptEdits'; h.state.row!.planModeEnabled = true; h.state.row!.workspaceKind = 'dialogue';
    h.state.live.stablePermissionModeState.mode = 'acceptEdits'; h.state.live.stablePlanModeState.enabled = true;
    const result = await h.fromMcp({ message: 'OK only', dispatcherSessionId: 'source', claudeExcludedMcpServers: names });
    expect(result).toMatchObject({ ok: true, wakeKind: 'created', model: 'test-model', providerId: 'test-provider',
      effort: 'low', fastMode: false, claudeExcludedMcpServers: [...new Set(names)] });
    expect(h.bootstrap).toHaveBeenCalledOnce();
    expect(h.bootstrap.mock.calls[0][0]).toMatchObject({ agentKind: 'claude-code', model: 'test-model',
      providerId: 'test-provider', workingDir: 'C:/test', workspaceKind: 'dialogue', permissionMode: 'ask',
      planMode: true, vendorOptions: { claudeExcludedMcpServers: [...new Set(names)] } });
    expect(h.open.mock.calls[0][0].body).toMatchObject({ permissionMode: 'ask', planModeEnabled: true });
    expect(h.send.mock.calls[0][3].planMode).toBe(true);
    expect(h.worktree).not.toHaveBeenCalled();
  });

  it.each([
    { targetSessionId: 'old' }, { targetSessionId: '' }, { dispatcherSessionId: undefined }, { execution: {} },
    { dispatcherSessionId: undefined, createDefaults: { agentKind: 'claude-code', model: 'test-model' } },
    { workingDir: 'C:/other' }, { useWorktree: true }, { useWorktree: 'true' }, { claudeExcludedMcpServers: ['*'] },
    { claudeExcludedMcpServers: null },
  ])('rejects invalid requests before source lookup: %j', async patch => {
    const h = harness();
    const result = await h.run({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [], ...patch });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(h.readIdentity).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled(); expect(h.bootstrap).not.toHaveBeenCalled();
    expect(h.worktree).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });

  it('does not let the MCP adapter drop conflicting execution overrides', async () => {
    const h = harness();
    expect(await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source', model: 'other', claudeExcludedMcpServers: [] }))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(h.readIdentity).not.toHaveBeenCalled(); expect(h.open).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });

  it.each([
    { key: 'status', value: 'archived' }, { key: 'source', value: 'bot' }, { key: 'source', value: 'review' },
    { key: 'agentKind', value: 'codex' }, { key: 'remoteHostId', value: 'remote' }, { key: 'orcaRole', value: 'lead' },
    { key: 'workingDir', value: 'C:/changed' },
  ])('rejects unsupported source $key=$value without creation', async ({ key, value }) => {
    const h = harness(); h.state.row![key] = value;
    const result = await h.run({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] });
    expect(result.ok).toBe(false); expect(h.open).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['missing-row', 'bot-link', 'remote-meta', 'codex-meta', 'route-pending', 'missing-provider'])('fails closed for %s', async fault => {
    const h = harness();
    if (fault === 'missing-row') h.state.row = undefined;
    if (fault === 'bot-link') h.state.linked = true;
    if (fault === 'remote-meta') h.state.meta.remoteHostId = 'remote';
    if (fault === 'codex-meta') h.state.meta.agentKind = 'codex';
    if (fault === 'route-pending') h.state.controls.source.pending = {};
    if (fault === 'missing-provider') h.state.routes.source.provider = '';
    expect((await h.run({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] })).ok).toBe(false);
    expect(h.open).not.toHaveBeenCalled(); expect(h.bootstrap).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['owner', 'scope', 'revision', 'in-place-generation', 'instance', 'row', 'bot-link', 'admission'])('rejects %s drift before persistence/bootstrap', async drift => {
    const h = harness();
    h.state.beforeCommit = () => {
      if (drift === 'owner') h.state.owner = {};
      if (drift === 'scope') h.state.scope++;
      if (drift === 'revision') h.state.revision++;
      if (drift === 'in-place-generation') h.state.controls.source.generation++;
      if (drift === 'instance') h.state.live = { ...h.state.live };
      if (drift === 'row') h.state.row!.status = 'archived';
      if (drift === 'bot-link') h.state.linked = true;
      if (drift === 'admission') h.state.admittedPatch.providerId = 'different-provider';
    };
    expect((await h.run({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: ['wwise-mcp'] })).ok).toBe(false);
    expect(h.bootstrap).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.worktree).not.toHaveBeenCalled();
  });

  it('ignores source permission/Plan drift and allows SDK id publication', async () => {
    const h = harness();
    h.state.afterAccepted = () => {
      h.state.live.stablePermissionModeState = { mode: 'bypassPermissions', generation: 9 };
      h.state.live.stablePlanModeState = { enabled: true, generation: 9 };
      h.state.row!.permissionMode = 'bypassPermissions'; h.state.row!.planModeEnabled = true;
      h.child.sdkSessionId = 'published-sdk-id';
    };
    expect(await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] }))
      .toMatchObject({ ok: true, providerId: 'test-provider', effort: 'low', fastMode: false });
    expect(h.dispatch).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled();
    expect(h.state.childRow).toMatchObject({ permissionMode: 'ask', planModeEnabled: true });
  });

  it.each(['source-row', 'source-instance', 'source-route', 'credential-revision', 'bot-link'])
    ('closes exact handle after %s drift but preserves the accepted message', async fault => {
      const h = harness();
      h.state.afterAccepted = () => {
        if (fault === 'source-row') h.state.row!.status = 'archived';
        if (fault === 'source-instance') h.state.live = { ...h.state.live };
        if (fault === 'source-route') h.state.routes.source.effort = 'high';
        if (fault === 'credential-revision') h.state.revision++;
        if (fault === 'bot-link') h.state.linked = true;
      };
      expect(await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] }))
        .toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', diagnostic: {
          targetSessionId: 'child', dispatchStarted: false, draftState: 'preserved-closed' } });
      expect(h.message).toHaveBeenCalledOnce(); expect(h.state.childRow).toBeDefined();
      expect(h.dispatch).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalledWith(h.child, 'requested');
      expect(h.rollback).toHaveBeenCalledExactlyOnceWith('child', 'message', 'send_to_session:diagnostic:failed-before-dispatch');
    });

  it.each(['owner', 'scope', 'replacement', 'permission', 'plan', 'turn', 'runtime-generation', 'close-failure', 'owner-during-close', 'unpublished'])
    ('reports cleanup incomplete on %s without deleting a draft', async fault => {
      const h = harness();
      if (fault === 'unpublished') h.state.beforeBootstrap = () => { throw new Error('startup failed'); };
      else h.state.afterAccepted = () => {
        h.state.row!.status = 'archived';
        if (fault === 'owner') h.state.owner = {};
        if (fault === 'scope') h.state.scope++;
        if (fault === 'replacement') h.state.childCurrent = { ...h.child, instanceId: 'replacement' };
        if (fault === 'permission') h.child.stablePermissionModeState.generation++;
        if (fault === 'plan') h.child.stablePlanModeState.generation++;
        if (fault === 'turn') h.child.turn++;
        if (fault === 'runtime-generation') h.state.controls.child.generation++;
        if (fault === 'close-failure') h.close.mockRejectedValueOnce(new Error('close failed'));
        if (fault === 'owner-during-close') h.state.duringClose = () => { h.state.owner = {}; };
      };
      expect(await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] }))
        .toMatchObject({ ok: false, errorCode: 'CLEANUP_INCOMPLETE', diagnostic: {
          targetSessionId: 'child', dispatchStarted: false, draftState: 'cleanup-incomplete' } });
      expect(h.state.childRow).toBeDefined(); expect(h.dispatch).not.toHaveBeenCalled();
      if (!['close-failure', 'owner-during-close'].includes(fault)) expect(h.close).not.toHaveBeenCalled();
    });

  it.each(['pass', 'fail-after-persistence'] as const)('executes production Host with real Session: %s', async mode => {
    const h = harness(true);
    if (mode === 'fail-after-persistence') h.state.afterAccepted = () => { h.state.row!.status = 'archived'; };
    try {
      const result = await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] });
      expect(h.message).toHaveBeenCalledOnce();
      if (mode === 'pass') {
        expect(result).toMatchObject({ ok: true, model: 'test-model', providerId: 'test-provider' });
        expect(h.vendorSend).toHaveBeenCalledOnce(); expect(h.rollback).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', diagnostic: {
          draftState: 'preserved-closed', dispatchStarted: false } });
        expect(h.vendorSend).not.toHaveBeenCalled(); expect(h.child.getTurnGeneration()).toBe(0);
        expect(h.child.getStatus()).toBe('closed'); expect(h.state.childRow).toBeDefined();
        expect(h.rollback).toHaveBeenCalledExactlyOnceWith('child', 'message', 'send_to_session:diagnostic:failed-before-dispatch');
      }
    } finally { await h.child.close(); }
  });

  it('does not report an accepted send with no dispatch receipt as success', async () => {
    const h = harness(); h.send.mockImplementationOnce(async () => ({ accepted: true }));
    expect(await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] }))
      .toMatchObject({ ok: false, errorCode: 'CLEANUP_INCOMPLETE', diagnostic: { dispatchStarted: true } });
    expect(h.close).not.toHaveBeenCalled();
  });

  it('uses the coherent live route rather than stale stored effort/Fast', async () => {
    const h = harness(); h.state.row!.effort = 'high'; h.state.row!.fastMode = true;
    expect(await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source', claudeExcludedMcpServers: [] }))
      .toMatchObject({ ok: true, effort: 'low', fastMode: false });
    expect(h.bootstrap.mock.calls[0][0]).toMatchObject({ effort: 'low', fastMode: false });
  });

  it('leaves default handoff behavior unchanged when no profile is supplied', async () => {
    const h = harness();
    expect((await h.fromMcp({ message: 'OK', dispatcherSessionId: 'source' })).ok).toBe(true);
    expect(h.bootstrap.mock.calls[0][0].permissionMode).toBe('bypassPermissions');
    expect(h.bootstrap.mock.calls[0][0].vendorOptions).not.toHaveProperty('claudeExcludedMcpServers');
    expect(h.bootstrap.mock.calls[0][0].vendorOptions.onStderrLine).toEqual(expect.any(Function));
    expect(h.open.mock.calls[0][0].body).not.toHaveProperty('planModeEnabled');
    expect(h.send.mock.calls[0][3].planMode).toBe(false);
  });
});
