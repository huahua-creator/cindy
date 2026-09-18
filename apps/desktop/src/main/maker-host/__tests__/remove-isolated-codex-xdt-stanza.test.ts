/**
 * 段 6：只清 Cindy 隔离 userData/codex-home/config.toml。
 * 测试只用独立 temp userData。禁止读/写 ~/.codex 或生产 userData。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Maker,
  cindyIsolatedCodexConfigPath,
  isXdtMemoryBinding,
  loadUpdateCindyCodexConfig,
  type AgentEvent,
  type AgentSessionHandle,
  type BaseAgent,
  type CreateSessionOptions,
  type SessionMeta,
  type SessionStorage,
} from '@cindy/maker-core';

import { attachSessionWorkspaceIdentity } from '../attach-session-workspace-identity.js';
import { prepareReadonlyXdtSession } from '../prepare-readonly-xdt-session.js';
import {
  forgetPreparedMemorySessionForSessionId,
  getPreparedMemorySession,
  resetPreparedMemorySessionsForTest,
} from '../prepared-memory-sessions.js';
import {
  forgetSessionWorkspaceIdentity,
  getSessionWorkspaceIdentity,
  rememberSessionWorkspaceIdentity,
  resetSessionWorkspaceIdentityForTest,
} from '../session-workspace-identity.js';
import { createLocalAlias } from '../workspace-identity-registry.js';
import {
  ensureIsolatedCodexXdtStanzaRemoved,
  removeIsolatedCodexXdtStanza,
  resetIsolatedCodexXdtStanzaRemovalForTest,
} from '../remove-isolated-codex-xdt-stanza.js';

const OWNER_ID = 'owner-fixture-1';
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const HEX_B = 'b'.repeat(64);

const temps: string[] = [];

afterEach(async () => {
  resetIsolatedCodexXdtStanzaRemovalForTest();
  resetSessionWorkspaceIdentityForTest();
  resetPreparedMemorySessionsForTest();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function contiguousStanza(): string {
  return [
    '[mcp_servers.xdt-memory]',
    'command = "node"',
    'args = ["server.mjs"]',
    'cwd = "/tmp/xdt-memory"',
    '',
    '[mcp_servers.xdt-memory.env]',
    'XDT_MEMORY_INTROSPECTION_ONLY = "1"',
    '',
  ].join('\n');
}

function otherTables(): string {
  return [
    '[plugins."keep@personal"]',
    'enabled = true',
    '',
    '[projects."/tmp/keep"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');
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

function createHandle(id: string, agentKind: CreateSessionOptions['agentKind'] = 'codex'): AgentSessionHandle {
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
}): BaseAgent {
  let nativeEnabled = true;
  return {
    kind: input.kind ?? 'codex',
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

function managerStub(enabled = true) {
  return {
    manager: {
      isEnabled: () => enabled,
      markXdtReadOnlyScope() {},
    },
  };
}

async function emptyIndexTree() {
  const repoRoot = await tempDir('cindy-xdt-stanza-tree-');
  const dataRoot = path.join(repoRoot, 'data');
  await mkdir(dataRoot, { recursive: true });
  return { repoRoot, dataRoot };
}

function assertNoForbiddenHomes(...values: string[]) {
  for (const value of values) {
    const normalized = value.replaceAll('\\', '/');
    expect(normalized).not.toMatch(/\/\.codex(\/|$)/);
    expect(normalized).not.toMatch(/claude_obsidian_work/i);
  }
}

describe('removeIsolatedCodexXdtStanza', () => {
  it('removes a contiguous stanza and keeps other TOML tables', async () => {
    const userData = await tempDir('cindy-xdt-stanza-ud-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${otherTables()}${contiguousStanza()}`, 'utf8');
    assertNoForbiddenHomes(userData, configPath);
    const result = await removeIsolatedCodexXdtStanza({ userDataDir: () => userData });
    expect(result.status).toBe('removed');
    const next = await readFile(configPath, 'utf8');
    expect(next).not.toContain('[mcp_servers.xdt-memory]');
    expect(next).toContain('[plugins."keep@personal"]');
    expect(next).toContain('[projects."/tmp/keep"]');
  });

  it('is idempotent when the config file is missing and does not mkdir', async () => {
    const userData = await tempDir('cindy-xdt-stanza-missing-');
    const result = await removeIsolatedCodexXdtStanza({ userDataDir: () => userData });
    expect(result.status).toBe('missing');
    expect(await readdir(userData)).toEqual([]);
  });

  it('is idempotent when no stanza is present and does not rewrite', async () => {
    const userData = await tempDir('cindy-xdt-stanza-none-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = `${otherTables()}# keep\n`;
    await writeFile(configPath, original, 'utf8');
    const result = await removeIsolatedCodexXdtStanza({ userDataDir: () => userData });
    expect(result.status).toBe('unchanged');
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('fails closed on bad TOML and leaves the file bytes unchanged', async () => {
    const userData = await tempDir('cindy-xdt-stanza-bad-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = 'not = [toml';
    await writeFile(configPath, original, 'utf8');
    await expect(removeIsolatedCodexXdtStanza({ userDataDir: () => userData })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('fails closed on a non-contiguous stanza and leaves the file unchanged', async () => {
    const userData = await tempDir('cindy-xdt-stanza-split-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = [
      '[mcp_servers.xdt-memory]',
      'command = "node"',
      'args = ["server.mjs"]',
      'cwd = "/tmp/xdt-memory"',
      '',
      '[plugins.keep]',
      'enabled = true',
      '',
      '[mcp_servers.xdt-memory.env]',
      'XDT_MEMORY_INTROSPECTION_ONLY = "1"',
      '',
    ].join('\n');
    await writeFile(configPath, original, 'utf8');
    await expect(removeIsolatedCodexXdtStanza({ userDataDir: () => userData })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('does not use readIsolatedCodexStanzaPresent catch-false as the cleanup authority', async () => {
    const src = await readFile(new URL('../remove-isolated-codex-xdt-stanza.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/readIsolatedCodexStanzaPresent/);
    expect(src).not.toMatch(/homedir\(/);
    expect(src).not.toMatch(/os\.homedir/);
    expect(src).not.toMatch(/join\([^)]*['\"]\.codex['\"]/);
    expect(src).not.toMatch(/spawn\(/);
    expect(src).not.toMatch(/\batomicWrite\b/);
  });
});

describe('ensureIsolatedCodexXdtStanzaRemoved once', () => {
  it('does not rewrite after a successful process-local run', async () => {
    const userData = await tempDir('cindy-xdt-stanza-once-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${otherTables()}${contiguousStanza()}`, 'utf8');
    const update = vi.fn((text: string, request: { state: 'remove' }) =>
      loadUpdateCindyCodexConfig()(text, request),
    );
    const loadUpdate = vi.fn(() => update);
    const first = await ensureIsolatedCodexXdtStanzaRemoved({
      userDataDir: () => userData,
      loadUpdate,
    });
    expect(first.status).toBe('removed');
    const afterFirst = await readFile(configPath, 'utf8');
    const second = await ensureIsolatedCodexXdtStanzaRemoved({
      userDataDir: () => userData,
      loadUpdate,
    });
    expect(second).toEqual(first);
    expect(await readFile(configPath, 'utf8')).toBe(afterFirst);
    expect(loadUpdate).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('rejects a fake isolatedConfigPath that is not userData/codex-home/config.toml', async () => {
    const userData = await tempDir('cindy-xdt-stanza-fake-path-');
    const fakeDir = path.join(userData, 'elsewhere');
    await mkdir(fakeDir, { recursive: true });
    const fakePath = path.join(fakeDir, 'config.toml');
    const original = contiguousStanza();
    await writeFile(fakePath, original, 'utf8');
    await expect(
      ensureIsolatedCodexXdtStanzaRemoved({
        userDataDir: () => userData,
        isolatedConfigPath: () => fakePath,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(await readFile(fakePath, 'utf8')).toBe(original);
    await expect(readdir(path.join(userData, 'codex-home'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed when userDataDir is missing or empty', async () => {
    await expect(ensureIsolatedCodexXdtStanzaRemoved({})).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(
      ensureIsolatedCodexXdtStanzaRemoved({ userDataDir: () => '' }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('does not sticky a CONFIG_INVALID failure; the next ensure still fails closed', async () => {
    const userData = await tempDir('cindy-xdt-stanza-bad-once-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = 'not = [toml';
    await writeFile(configPath, original, 'utf8');
    const loadUpdate = vi.fn((root?: string) => loadUpdateCindyCodexConfig(root));
    await expect(
      ensureIsolatedCodexXdtStanzaRemoved({
        userDataDir: () => userData,
        loadUpdate,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      ensureIsolatedCodexXdtStanzaRemoved({
        userDataDir: () => userData,
        loadUpdate,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(loadUpdate).toHaveBeenCalledTimes(2);
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('shares one inFlight across concurrent ensure calls', async () => {
    const userData = await tempDir('cindy-xdt-stanza-concurrent-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${otherTables()}${contiguousStanza()}`, 'utf8');
    const loadUpdate = vi.fn((root?: string) => loadUpdateCindyCodexConfig(root));
    const first = ensureIsolatedCodexXdtStanzaRemoved({
      userDataDir: () => userData,
      loadUpdate,
    });
    const second = ensureIsolatedCodexXdtStanzaRemoved({
      userDataDir: () => userData,
      loadUpdate,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.status).toBe('removed');
    expect(loadUpdate).toHaveBeenCalledTimes(1);
    expect(await readFile(configPath, 'utf8')).not.toContain('[mcp_servers.xdt-memory]');
  });

  it('cleans a stanza written back after a successful sticky run without reset', async () => {
    const userData = await tempDir('cindy-xdt-stanza-rewrite-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${otherTables()}${contiguousStanza()}`, 'utf8');
    const loadUpdate = vi.fn((root?: string) => loadUpdateCindyCodexConfig(root));
    const first = await ensureIsolatedCodexXdtStanzaRemoved({
      userDataDir: () => userData,
      loadUpdate,
    });
    expect(first.status).toBe('removed');
    await writeFile(configPath, `${otherTables()}${contiguousStanza()}`, 'utf8');
    const second = await ensureIsolatedCodexXdtStanzaRemoved({
      userDataDir: () => userData,
      loadUpdate,
    });
    expect(second.status).toBe('removed');
    expect(await readFile(configPath, 'utf8')).not.toContain('[mcp_servers.xdt-memory]');
    expect(loadUpdate).toHaveBeenCalledTimes(3);
  });
});

describe('prepareReadonly after stanza cleanup', () => {
  it('prepares a registered Codex session once the isolated stanza is gone', async () => {
    const ownerRoot = await tempDir('cindy-xdt-stanza-owner-');
    const absDir = await tempDir('cindy-xdt-stanza-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const userData = await tempDir('cindy-xdt-stanza-ud2-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, contiguousStanza(), 'utf8');
    await removeIsolatedCodexXdtStanza({ userDataDir: () => userData });
    expect(await readFile(configPath, 'utf8')).not.toContain('[mcp_servers.xdt-memory]');
    const tree = await emptyIndexTree();
    const nativeAgent = createAgent({
      startSession: async () => createHandle('thread-codex-xdt'),
    });
    rememberSessionWorkspaceIdentity('session-codex-cleaned', {
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
    await prepareReadonlyXdtSession('session-codex-cleaned', opts, {
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
    expect(isXdtMemoryBinding(opts.preparedMemorySession?.binding)).toBe(true);
    expect(opts.preparedMemorySession?.binding.canonicalWorkspaceId).toBe(created.canonicalWorkspaceId);
    expect(getPreparedMemorySession(opts.preparedMemorySession!.preparedMemorySessionId)).toBe(
      opts.preparedMemorySession,
    );
  });

  it('skips a registered Codex session after the stanza is written back', async () => {
    const ownerRoot = await tempDir('cindy-xdt-stanza-owner-');
    const absDir = await tempDir('cindy-xdt-stanza-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const userData = await tempDir('cindy-xdt-stanza-ud3-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, contiguousStanza(), 'utf8');
    const tree = await emptyIndexTree();
    const setMemory = vi.fn(async () => ({ effective: 'next-session' as const }));
    const nativeAgent = createAgent({
      startSession: async (opts) => {
        expect(opts.preparedMemorySession).toBeUndefined();
        return createHandle('thread-codex-skip');
      },
      setMemory,
    });
    rememberSessionWorkspaceIdentity('session-codex-rewritten', {
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
    await prepareReadonlyXdtSession('session-codex-rewritten', opts, {
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
  });

  it('leaves an unregistered Codex session without preparedMemorySession', async () => {
    const ownerRoot = await tempDir('cindy-xdt-stanza-owner-');
    const absDir = await tempDir('cindy-xdt-stanza-ws-');
    const userData = await tempDir('cindy-xdt-stanza-ud4-');
    const tree = await emptyIndexTree();
    const startSession = async (opts: CreateSessionOptions) => {
      expect(opts.preparedMemorySession).toBeUndefined();
      return createHandle('thread-codex-unreg');
    };
    const maker = new Maker({
      agents: { codex: createAgent({ startSession }) },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: OWNER_ID, ownerRoot }),
          });
          await prepareReadonlyXdtSession(sessionId, opts, {
            getAgent: () => createAgent({ startSession }),
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
        },
        onClose: async (sessionId) => {
          forgetSessionWorkspaceIdentity(sessionId);
          forgetPreparedMemorySessionForSessionId(sessionId);
        },
      },
    });
    await maker.createSession({
      id: 'session-codex-unregistered',
      agentKind: 'codex',
      workingDir: absDir,
      model: 'gpt-5.4',
      makerMemoryEnabled: true,
    });
    expect(getSessionWorkspaceIdentity('session-codex-unregistered')).toBeUndefined();
  });

  it('still prepares Claude when an isolated stanza remains', async () => {
    const ownerRoot = await tempDir('cindy-xdt-stanza-owner-');
    const absDir = await tempDir('cindy-xdt-stanza-ws-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const userData = await tempDir('cindy-xdt-stanza-ud5-');
    const configPath = cindyIsolatedCodexConfigPath(userData);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, contiguousStanza(), 'utf8');
    const tree = await emptyIndexTree();
    const nativeAgent = createAgent({
      kind: 'claude-code',
      startSession: async () => createHandle('thread-claude', 'claude-code'),
    });
    rememberSessionWorkspaceIdentity('session-claude-stanza', {
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
    await prepareReadonlyXdtSession('session-claude-stanza', opts, {
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
    expect(isXdtMemoryBinding(opts.preparedMemorySession?.binding)).toBe(true);
    expect(await readFile(configPath, 'utf8')).toContain('[mcp_servers.xdt-memory]');
  });

  it('wires stanza removal before the plugins bridge and not on every createSession', async () => {
    const { readFile: read } = await import('node:fs/promises');
    const auth = await read(new URL('../auth-adapters.ts', import.meta.url), 'utf8');
    const remove = auth.indexOf('await ensureIsolatedCodexXdtStanzaRemoved');
    const plugins = auth.indexOf('prepareCodexGlobalPluginsBridge(this.codexHome');
    expect(remove).toBeGreaterThan(0);
    expect(plugins).toBeGreaterThan(remove);
    const prepare = await read(new URL('../prepare-readonly-xdt-session.ts', import.meta.url), 'utf8');
    expect(prepare).not.toMatch(/\bensureIsolatedCodexXdtStanzaRemoved\b/);
    expect(prepare).not.toMatch(/\bremoveIsolatedCodexXdtStanza\b/);
  });
});
