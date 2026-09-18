/**
 * 段 5：已确认 UUID 的本机合格会话，对独立 temp 生产形 xdt 树只读 prepare。
 * 测试 UUID / data 只服务独立 temp git/data 树，禁止读生产 vault 或生产 xdt data。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Maker,
  XdtPrepareError,
  createXdtMemoryIndexClient,
  isXdtMemoryBinding,
  type AgentEvent,
  type AgentSessionHandle,
  type BaseAgent,
  type CreateSessionOptions,
  type SessionMeta,
  type SessionStorage,
} from '@cindy/maker-core';
import { createLiziMcpProviders, type LiziMcpSessionContext } from '@cindy/mcps';

import { attachSessionWorkspaceIdentity } from '../attach-session-workspace-identity.js';
import {
  CINDY_HOST_READONLY_SERVER_REGISTRATION_ID,
  prepareReadonlyXdtSession,
} from '../prepare-readonly-xdt-session.js';
import {
  forgetPreparedMemorySessionForSessionId,
  getPreparedMemorySession,
  rememberPreparedMemorySession,
  resetPreparedMemorySessionsForTest,
} from '../prepared-memory-sessions.js';
import {
  forgetSessionWorkspaceIdentity,
  getSessionWorkspaceIdentity,
  rememberSessionWorkspaceIdentity,
  resetSessionWorkspaceIdentityForTest,
} from '../session-workspace-identity.js';
import { createLocalAlias } from '../workspace-identity-registry.js';

const HEX_B = 'b'.repeat(64);
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PREPARED_FIXTURE_ID = '44444444-4444-4444-8444-444444444444';
const OWNER_ID = 'owner-fixture-1';

const temps: string[] = [];

afterEach(async () => {
  resetSessionWorkspaceIdentityForTest();
  resetPreparedMemorySessionsForTest();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

function laneOf(ctx: Partial<LiziMcpSessionContext> | undefined): 'internal' | 'xdt' | 'disabled' {
  if (ctx?.memoryBinding && isXdtMemoryBinding(ctx.memoryBinding)) return 'xdt';
  if (ctx?.preparedMemorySessionId) return 'disabled';
  if (ctx?.memoryBinding) return 'disabled';
  if (ctx?.memoryProviderRequested === 'xdt') return 'disabled';
  return 'internal';
}

function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
}

function createStorage(): SessionStorage {
  const rows = new Map<string, SessionMeta>();
  return {
    async create(meta) {
      const now = Date.now();
      const row = { ...meta, createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error(`missing ${id}`);
      const next = { ...row, ...patch, updatedAt: Date.now() };
      rows.set(id, next);
      return next;
    },
    async compareAndClearSdkSessionId() {
      return false;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

async function* neverEndingIterator(): AsyncGenerator<AgentEvent> {
  await new Promise<never>(() => {});
  yield undefined as never;
}

function createHandle(id: string, agentKind: CreateSessionOptions['agentKind'] = 'claude-code'): AgentSessionHandle {
  return {
    id,
    agentKind,
    model: agentKind === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-5',
    async send() {},
    async steer() {},
    async abort() {},
    async close() {},
    async *events() { yield* neverEndingIterator(); },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
    isTurnRunning: () => false,
  };
}

function createAgent(input: {
  kind?: CreateSessionOptions['agentKind'];
  startSession: (opts: CreateSessionOptions) => Promise<unknown>;
  setMemory?: (enabled: boolean) => Promise<{ effective: 'immediate' | 'next-session' | 'unsupported' }>;
  getMemoryStatus?: () => Promise<{ enabled: boolean; source: 'host-runtime' }>;
}): BaseAgent {
  let nativeEnabled = true;
  return {
    kind: input.kind ?? 'claude-code',
    capabilities: {
      availableModels: [],
      effortLevels: [],
      permissionModes: [],
      reasoning: { supported: false },
      images: { supported: false },
      slashCommands: { supported: false },
      customSlashCommands: { supported: false },
      memory: { supported: true },
      fork: { supported: false },
      rewind: { supported: false },
      extraDirs: { supported: false },
    },
    startSession: input.startSession,
    async setMemory(enabled: boolean) {
      if (input.setMemory) return input.setMemory(enabled);
      nativeEnabled = enabled;
      return { effective: 'next-session' as const };
    },
    async getMemoryStatus() {
      if (input.getMemoryStatus) return input.getMemoryStatus();
      return { enabled: nativeEnabled, source: 'host-runtime' as const };
    },
    async dispose() {},
  } as unknown as BaseAgent;
}

function logger() {
  const log = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return log;
    },
  };
  return log;
}

async function emptyIndexTree(): Promise<{ repoRoot: string; dataRoot: string }> {
  const repoRoot = await tempDir('cindy-xdt-prod-tree-');
  const dataRoot = path.join(repoRoot, 'data');
  await mkdir(dataRoot, { recursive: true });
  return { repoRoot, dataRoot };
}

async function seedV2ProjectHead(dataRoot: string, workspace: string) {
  const id = 'fixture';
  const directory = path.join(dataRoot, 'records', workspace, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${id}.json`),
    `${JSON.stringify({
      schema_version: 2,
      id,
      key: `${workspace}/${id}`,
      title: 'Fixture',
      description: 'isolated fixture record',
      content: 'fixture body',
      kind: 'project',
      scope: 'workspace',
      workspace,
      tags: [],
      source_harness: 'cindy',
      source_ref: null,
      archived: false,
      archive_reason: null,
      updated_at: '2026-09-16T00:00:00.000Z',
      device: 'cindy-host-readonly',
      parent_revision: null,
      operation_id: randomUUID(),
      request_digest: HEX_B,
    }, null, 2)}\n`,
    'utf8',
  );
}

function managerStub(enabled = true) {
  const marked: string[] = [];
  return {
    marked,
    manager: {
      isEnabled: () => enabled,
      markXdtReadOnlyScope(scope: string) {
        marked.push(scope);
      },
    },
  };
}

function assertNoProductionPaths(...paths: string[]) {
  for (const value of paths) {
    expect(value).not.toMatch(/claude_obsidian_work/i);
    expect(value).not.toBe('D:/AI/Codex/xdt-memory');
    expect(value.replaceAll('\\', '/')).not.toMatch(/\/AI\/Codex\/xdt-memory\/data$/i);
  }
}

describe('prepareReadonlyXdtSession', () => {
  it('leaves an unregistered Claude session on the internal lane', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const tree = await emptyIndexTree();
    const setMemory = vi.fn(async () => ({ effective: 'next-session' as const }));
    const startSession = async (opts: CreateSessionOptions) => {
      expect(opts.preparedMemorySession).toBeUndefined();
      expect(isXdtMemoryBinding(opts.preparedMemorySession?.binding)).toBe(false);
      expect(laneOf({
        agentKind: 'claude-code',
        workingDir: absDir,
        memoryBinding: opts.preparedMemorySession?.binding,
        preparedMemorySessionId: opts.preparedMemorySession?.preparedMemorySessionId,
      })).toBe('internal');
      return createHandle('thread-internal');
    };
    const maker = new Maker({
      agents: { 'claude-code': createAgent({ startSession, setMemory }) },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
          });
          await prepareReadonlyXdtSession(sessionId, opts, {
            getAgent: () => createAgent({ startSession, setMemory }),
            getMakerMemory: () => managerStub().manager as never,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
            resolveIndexSource: (workspace) => ({
              repoRoot: tree.repoRoot,
              dataRoot: tree.dataRoot,
              workspace,
              device: 'cindy-host-readonly',
            }),
            userDataDir: () => ownerRoot,
          });
        },
      },
    });
    await maker.createSession({
      id: 'session-unregistered-ro',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      makerMemoryEnabled: true,
    });
    expect(getSessionWorkspaceIdentity('session-unregistered-ro')).toBeUndefined();
    expect(setMemory).not.toHaveBeenCalled();
  });

  it('prepares a registered Claude session against an empty production-shaped tree', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const tree = await emptyIndexTree();
    assertNoProductionPaths(tree.repoRoot, tree.dataRoot, absDir, ownerRoot);
    const getStore = vi.fn(async () => {
      throw new Error('internal store must not be used on xdt lane');
    });
    let captured: CreateSessionOptions | undefined;
    const nativeAgent = createAgent({
      startSession: async (opts) => {
        captured = opts;
        return createHandle('thread-xdt');
      },
    });
    const maker = new Maker({
      agents: { 'claude-code': nativeAgent },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
          });
          await prepareReadonlyXdtSession(sessionId, opts, {
            getAgent: () => nativeAgent,
            getMakerMemory: () => managerStub().manager as never,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
            resolveIndexSource: (workspace) => ({
              repoRoot: tree.repoRoot,
              dataRoot: tree.dataRoot,
              workspace,
              device: 'cindy-host-readonly',
            }),
            userDataDir: () => ownerRoot,
          });
        },
      },
    });
    const session = await maker.createSession({
      id: 'session-registered-empty',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      makerMemoryEnabled: true,
    });
    expect(captured?.preparedMemorySession).toBeDefined();
    expect(isXdtMemoryBinding(captured?.preparedMemorySession?.binding)).toBe(true);
    expect(captured?.preparedMemorySession?.binding.canonicalWorkspaceId).toBe(
      created.canonicalWorkspaceId,
    );
    expect(captured?.preparedMemorySession?.binding.serverRegistrationId).toBe(
      CINDY_HOST_READONLY_SERVER_REGISTRATION_ID,
    );
    expect(captured?.preparedMemorySession?.binding.serverRegistrationDigest).not.toBe('a'.repeat(64));
    expect(captured?.preparedMemorySession?.nativeMemoryProof.sessionInstanceId).toBe(
      session.instanceId,
    );
    expect(captured?.sessionInstanceId).toBe(session.instanceId);
    const prepared = captured!.preparedMemorySession!;
    expect(getPreparedMemorySession(prepared.preparedMemorySessionId)).toBe(prepared);

    const ctx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: absDir,
      memoryBinding: prepared.binding,
      preparedMemorySessionId: prepared.preparedMemorySessionId,
    };
    expect(laneOf(ctx)).toBe('xdt');
    const provider = createLiziMcpProviders({
      memory: {
        getManager: () => ({ isEnabled: () => true, getStore }) as never,
        getPreparedMemorySession: (id) => getPreparedMemorySession(id),
      },
    }).find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory missing');
    const cfg = provider.toClaudeSdkConfig(ctx) as { instance: unknown };
    const listed = await tools(cfg.instance).call_tool.handler({
      name: 'memory_list',
      args: {},
    });
    expect(parse(listed as never)).toMatchObject({ ok: true, data: [] });
    const written = await tools(cfg.instance).call_tool.handler({
      name: 'memory_write',
      args: {
        type: 'project',
        name: 'should-fail',
        title: 'no',
        description: 'must not land on internal store',
        body: 'nope',
      },
    });
    expect(parse(written as never)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });
    expect(getStore).not.toHaveBeenCalled();
  });

  it('projects a v2 head from the injected tree without rebuilding MEMORY.md from get()', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const tree = await emptyIndexTree();
    await seedV2ProjectHead(tree.dataRoot, created.canonicalWorkspaceId);
    let captured: CreateSessionOptions | undefined;
    const nativeAgent = createAgent({
      startSession: async (opts) => {
        captured = opts;
        return createHandle('thread-v2');
      },
    });
    const maker = new Maker({
      agents: { 'claude-code': nativeAgent },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
          });
          await prepareReadonlyXdtSession(sessionId, opts, {
            getAgent: () => nativeAgent,
            getMakerMemory: () => managerStub().manager as never,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
            resolveIndexSource: (workspace) => ({
              repoRoot: tree.repoRoot,
              dataRoot: tree.dataRoot,
              workspace,
              device: 'cindy-host-readonly',
            }),
            userDataDir: () => ownerRoot,
          });
        },
      },
    });
    await maker.createSession({
      id: 'session-registered-v2',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      makerMemoryEnabled: true,
    });
    const prepared = captured?.preparedMemorySession;
    expect(prepared?.indexSnapshot.content).toContain('project_fixture.md');
    expect(prepared?.records.map((row) => row.filename)).toEqual(['project_fixture.md']);
    await expect(prepared?.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ filename: 'project_fixture.md' }),
    ]);

    const ctx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: absDir,
      memoryBinding: prepared!.binding,
      preparedMemorySessionId: prepared!.preparedMemorySessionId,
      preparedMemorySession: prepared,
    };
    expect(laneOf(ctx)).toBe('xdt');
    const getStore = vi.fn(async () => {
      throw new Error('internal store must not be used on xdt lane');
    });
    const provider = createLiziMcpProviders({
      memory: {
        getManager: () => ({ isEnabled: () => true, getStore }) as never,
        getPreparedMemorySession: (id) => getPreparedMemorySession(id),
      },
    }).find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory missing');
    const cfg = provider.toClaudeSdkConfig(ctx) as { instance: unknown };
    const listed = await tools(cfg.instance).call_tool.handler({
      name: 'memory_list',
      args: {},
    });
    expect(parse(listed as never)).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ filename: 'project_fixture.md' })],
    });
    expect(getStore).not.toHaveBeenCalled();
  });

  it('treats id-only preparedMemorySessionId as disabled, not xdt', () => {
    expect(
      laneOf({
        agentKind: 'claude-code',
        workingDir: '/tmp/xdt-readonly-repo',
        preparedMemorySessionId: PREPARED_FIXTURE_ID,
      }),
    ).toBe('disabled');
  });

  it('rolls back opts and remember when prepare fails inside the hook', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const tree = await emptyIndexTree();
    const nativeAgent = createAgent({
      startSession: async () => createHandle('thread-fail'),
      getMemoryStatus: async () => ({ enabled: true, source: 'host-runtime' }),
    });
    const opts: CreateSessionOptions = {
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: true,
    };
    rememberSessionWorkspaceIdentity('session-proof-fail', {
      canonicalWorkspaceId: created.canonicalWorkspaceId,
      locatorDigest: created.locatorDigest,
    });
    await expect(
      prepareReadonlyXdtSession('session-proof-fail', opts, {
        getAgent: () => nativeAgent,
        getMakerMemory: () => managerStub().manager as never,
        resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
        resolveIndexSource: (workspace) => ({
          repoRoot: tree.repoRoot,
          dataRoot: tree.dataRoot,
          workspace,
          device: 'cindy-host-readonly',
        }),
        userDataDir: () => ownerRoot,
      }),
    ).rejects.toBeInstanceOf(XdtPrepareError);
    expect(opts.preparedMemorySession).toBeUndefined();
    expect(getPreparedMemorySession(created.canonicalWorkspaceId)).toBeUndefined();
  });

  it('skips Codex when isolated stanza is present and does not inject a binding', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const userData = await tempDir('cindy-xdt-ro-userdata-');
    await mkdir(path.join(userData, 'codex-home'), { recursive: true });
    await writeFile(
      path.join(userData, 'codex-home', 'config.toml'),
      '[mcp_servers.xdt-memory]\nurl="http://127.0.0.1"\n',
      'utf8',
    );
    const tree = await emptyIndexTree();
    const setMemory = vi.fn(async () => ({ effective: 'immediate' as const }));
    const nativeAgent = createAgent({
      kind: 'codex',
      startSession: async (opts) => {
        expect(opts.preparedMemorySession).toBeUndefined();
        return createHandle('thread-codex', 'codex');
      },
      setMemory,
    });
    rememberSessionWorkspaceIdentity('session-codex-stanza', {
      canonicalWorkspaceId: created.canonicalWorkspaceId,
      locatorDigest: created.locatorDigest,
    });
    const opts: CreateSessionOptions = {
      agentKind: 'codex',
      workingDir: absDir,
      model: 'gpt-5.4',
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: true,
    };
    await prepareReadonlyXdtSession('session-codex-stanza', opts, {
      getAgent: () => nativeAgent,
      getMakerMemory: () => managerStub().manager as never,
      resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
      resolveIndexSource: (workspace) => ({
        repoRoot: tree.repoRoot,
        dataRoot: tree.dataRoot,
        workspace,
        device: 'cindy-host-readonly',
      }),
      userDataDir: () => userData,
    });
    expect(opts.preparedMemorySession).toBeUndefined();
    expect(setMemory).not.toHaveBeenCalled();
    expect(await readFile(path.join(userData, 'codex-home', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.xdt-memory]',
    );
  });

  it('aborts when qualified dataRoot is missing and does not mkdir', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const repoRoot = await tempDir('cindy-xdt-ro-missing-');
    const missingData = path.join(repoRoot, 'data');
    rememberSessionWorkspaceIdentity('session-missing-data', {
      canonicalWorkspaceId: created.canonicalWorkspaceId,
      locatorDigest: created.locatorDigest,
    });
    const nativeAgent = createAgent({
      startSession: async () => createHandle('thread-missing'),
    });
    const opts: CreateSessionOptions = {
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: true,
    };
    await expect(
      prepareReadonlyXdtSession('session-missing-data', opts, {
        getAgent: () => nativeAgent,
        getMakerMemory: () => managerStub().manager as never,
        resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
        resolveIndexSource: (workspace) => ({
          repoRoot,
          dataRoot: missingData,
          workspace,
          device: 'cindy-host-readonly',
        }),
        userDataDir: () => ownerRoot,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(opts.preparedMemorySession).toBeUndefined();
    await expect(rm(missingData, { recursive: false })).rejects.toThrow();
  });

  it('no-ops when preparedMemorySession is already present', async () => {
    const existing = { preparedMemorySessionId: PREPARED_FIXTURE_ID } as never;
    rememberPreparedMemorySession({
      preparedMemorySessionId: PREPARED_FIXTURE_ID,
    } as never);
    const opts: CreateSessionOptions = {
      agentKind: 'claude-code',
      workingDir: '/tmp/fixture',
      model: 'claude-sonnet-4-5',
      preparedMemorySession: existing,
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: true,
    };
    const setMemory = vi.fn();
    await prepareReadonlyXdtSession('session-fixture-noop', opts, {
      getAgent: () => createAgent({ startSession: async () => createHandle('x'), setMemory }),
      getMakerMemory: () => managerStub().manager as never,
      resolveIndexSource: () => {
        throw new Error('fixture no-op must not index a production-shaped tree');
      },
    });
    expect(opts.preparedMemorySession).toBe(existing);
    expect(setMemory).not.toHaveBeenCalled();
  });

  it('fails closed when userDataDir is missing after identity qualifies', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    rememberSessionWorkspaceIdentity('session-no-userdata', {
      canonicalWorkspaceId: created.canonicalWorkspaceId,
      locatorDigest: created.locatorDigest,
    });
    const opts: CreateSessionOptions = {
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: true,
    };
    await expect(
      prepareReadonlyXdtSession('session-no-userdata', opts, {
        getAgent: () => createAgent({ startSession: async () => createHandle('x') }),
        getMakerMemory: () => managerStub().manager as never,
        resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
        userDataDir: () => '',
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(opts.preparedMemorySession).toBeUndefined();
  });

  it('skips review and remoteHostId without preparing', async () => {
    const setMemory = vi.fn();
    const optsRemote: CreateSessionOptions = {
      agentKind: 'claude-code',
      workingDir: 'C:\\repo',
      model: 'claude-sonnet-4-5',
      remoteHostId: 'host-1',
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: true,
    };
    await prepareReadonlyXdtSession('session-remote', optsRemote, {
      getAgent: () => createAgent({ startSession: async () => createHandle('x'), setMemory }),
      getMakerMemory: () => managerStub().manager as never,
    });
    const optsReview: CreateSessionOptions = {
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-sonnet-4-5',
      reviewMode: true,
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: true,
    };
    await prepareReadonlyXdtSession('session-review', optsReview, {
      getAgent: () => createAgent({ startSession: async () => createHandle('x'), setMemory }),
      getMakerMemory: () => managerStub().manager as never,
    });
    expect(optsRemote.preparedMemorySession).toBeUndefined();
    expect(optsReview.preparedMemorySession).toBeUndefined();
    expect(setMemory).not.toHaveBeenCalled();
  });

  it('skips prepare when Maker Memory is off and does not setMemory', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    rememberSessionWorkspaceIdentity('session-memory-off', {
      canonicalWorkspaceId: created.canonicalWorkspaceId,
      locatorDigest: created.locatorDigest,
    });
    const setMemory = vi.fn();
    const opts: CreateSessionOptions = {
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      sessionInstanceId: SESSION_INSTANCE,
      makerMemoryEnabled: false,
    };
    await prepareReadonlyXdtSession('session-memory-off', opts, {
      getAgent: () => createAgent({ startSession: async () => createHandle('x'), setMemory }),
      getMakerMemory: () => managerStub(false).manager as never,
      resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
    });
    expect(opts.preparedMemorySession).toBeUndefined();
    expect(setMemory).not.toHaveBeenCalled();
  });

  it('forgets prepared by preparedId on close, not sessionId', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ro-owner-');
    const absDir = await tempDir('cindy-xdt-ro-ws-');
    await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const tree = await emptyIndexTree();
    let preparedId = '';
    const nativeAgent = createAgent({
      startSession: async (opts) => {
        preparedId = opts.preparedMemorySession?.preparedMemorySessionId ?? '';
        return createHandle('thread-close');
      },
    });
    const maker = new Maker({
      agents: { 'claude-code': nativeAgent },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
          });
          await prepareReadonlyXdtSession(sessionId, opts, {
            getAgent: () => nativeAgent,
            getMakerMemory: () => managerStub().manager as never,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
            resolveIndexSource: (workspace) => ({
              repoRoot: tree.repoRoot,
              dataRoot: tree.dataRoot,
              workspace,
              device: 'cindy-host-readonly',
            }),
            userDataDir: () => ownerRoot,
          });
        },
        onClose: async (sessionId) => {
          forgetSessionWorkspaceIdentity(sessionId);
          forgetPreparedMemorySessionForSessionId(sessionId);
        },
      },
    });
    await maker.createSession({
      id: 'session-close-maps',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      makerMemoryEnabled: true,
    });
    expect(preparedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(getPreparedMemorySession(preparedId)).toBeDefined();
    await maker.closeSession('session-close-maps');
    expect(getSessionWorkspaceIdentity('session-close-maps')).toBeUndefined();
    expect(getPreparedMemorySession(preparedId)).toBeUndefined();
    expect(getPreparedMemorySession('session-close-maps')).toBeUndefined();
  });

  it('does not import prepare into attach-session-workspace-identity.ts', async () => {
    const src = await readFile(
      new URL('../attach-session-workspace-identity.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/\bprepareMemorySession\b/);
    expect(src).not.toMatch(/\bprepareReadonlyXdtSession\b/);
    expect(src).not.toMatch(/\bMemoryStore\b/);
  });

  it('wires attach then prepareReadonly then persisted orca start', async () => {
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
    const attach = src.indexOf('await attachSessionWorkspaceIdentity(sessionId, opts);');
    const prepare = src.indexOf('await prepareReadonlyXdtSession(sessionId, opts');
    const persisted = src.indexOf(
      'await preparePersistedOrcaSessionStart(sessionId, opts as MakerSessionCreateOpts);',
    );
    const persistCatch = src.indexOf('forgetPreparedMemorySessionForSessionId(sessionId);', persisted);
    expect(attach).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(attach);
    expect(persisted).toBeGreaterThan(prepare);
    expect(persistCatch).toBeGreaterThan(persisted);
    expect(src).not.toMatch(/forgetPreparedMemorySession\(sessionId\)/);
  });

  it('keeps production index device cindy-host-readonly and fixture default cindy-host-fixture', async () => {
    const src = await readFile(
      path.resolve(process.cwd(), '../../packages/maker-core/src/memory/xdt-index.ts'),
      'utf8',
    ).catch(async () =>
      readFile(path.resolve(process.cwd(), 'packages/maker-core/src/memory/xdt-index.ts'), 'utf8'),
    );
    expect(src).toMatch(/device: source\.device \?\? 'cindy-host-fixture'/);
    expect(src).toMatch(/'cindy-host-readonly'/);
    expect(createXdtMemoryIndexClient).toBeTypeOf('function');
  });
});
