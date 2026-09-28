/**
 * 段 4：createSession 只读消费已确认 UUID。
 * 有 UUID ≠ 启用 xdt。未登记不得 mkdir ownerRoot。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Maker,
  XdtPrepareError,
  isXdtMemoryBinding,
  type AgentEvent,
  type AgentSessionHandle,
  type BaseAgent,
  type CreateSessionOptions,
  type SessionMeta,
  type SessionStorage,
} from '@cindy/maker-core';

import { attachSessionWorkspaceIdentity } from '../attach-session-workspace-identity.js';
import {
  forgetSessionWorkspaceIdentity,
  getSessionWorkspaceIdentity,
  rememberSessionWorkspaceIdentity,
  resetSessionWorkspaceIdentityForTest,
} from '../session-workspace-identity.js';
import { createLocalAlias, loadMemoryProviderSettings, readRegistry } from '../workspace-identity-registry.js';
import { publishWorkspaceMemoryProviderOverride } from './publish-workspace-override.js';
import { createIpcError } from '../../../shared/ipc-errors.js';

const temps: string[] = [];

afterEach(async () => {
  resetSessionWorkspaceIdentityForTest();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
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

function createHandle(id: string): AgentSessionHandle {
  return {
    id,
    agentKind: 'claude-code',
    model: 'claude-sonnet-4-5',
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

function createAgent(startSession: (opts: CreateSessionOptions) => Promise<unknown>): BaseAgent {
  return {
    kind: 'claude-code',
    capabilities: {
      availableModels: [],
      effortLevels: [],
      permissionModes: [],
      reasoning: { supported: false },
      images: { supported: false },
      slashCommands: { supported: false },
      customSlashCommands: { supported: false },
      memory: { supported: false },
      fork: { supported: false },
      rewind: { supported: false },
      extraDirs: { supported: false },
    },
    startSession,
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

describe('attachSessionWorkspaceIdentity', () => {
  it('leaves the snapshot empty for an unregistered directory and does not mkdir ownerRoot', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    const lookup = vi.fn();
    await attachSessionWorkspaceIdentity(
      'session-unregistered',
      { agentKind: 'claude-code', workingDir: absDir, model: 'claude-sonnet-4-5' },
      {
        assertEligibleDir: (dir) => dir,
        resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
        lookup,
      },
    );
    expect(getSessionWorkspaceIdentity('session-unregistered')).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(await readdir(ownerRoot)).toEqual([]);
  });

  it('remembers a registered directory UUID without injecting preparedMemorySession', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    const created = await createLocalAlias({
      dataOwnerId: 'owner-fixture-1',
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const startSession = async (opts: CreateSessionOptions) => {
      expect(opts.preparedMemorySession).toBeUndefined();
      expect(isXdtMemoryBinding(opts.preparedMemorySession?.binding)).toBe(false);
      return createHandle('thread-internal');
    };
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession) },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
          });
        },
        onClose: async (sessionId) => {
          forgetSessionWorkspaceIdentity(sessionId);
        },
      },
    });
    await maker.createSession({
      id: 'session-registered',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
    });
    expect(getSessionWorkspaceIdentity('session-registered')).toEqual({
      canonicalWorkspaceId: created.canonicalWorkspaceId,
      locatorDigest: created.locatorDigest,
    });
    expect(readRegistry({ dataOwnerId: 'owner-fixture-1', ownerRoot }).status).toBe('readable');
  });

  it('skips an unregistered directory even when another alias already exists', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const registered = await tempDir('cindy-xdt-attach-ws-');
    const other = await tempDir('cindy-xdt-attach-other-');
    await createLocalAlias({
      dataOwnerId: 'owner-fixture-1',
      ownerRoot,
      absDir: registered,
      confirmed: true,
    });
    await attachSessionWorkspaceIdentity(
      'session-other-dir',
      { agentKind: 'claude-code', workingDir: other, model: 'claude-sonnet-4-5' },
      {
        assertEligibleDir: (dir) => dir,
        resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
      },
    );
    expect(getSessionWorkspaceIdentity('session-other-dir')).toBeUndefined();
  });

  it('does not mint a UUID just because a session was created without confirmed create', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    await attachSessionWorkspaceIdentity(
      'session-no-confirm',
      { agentKind: 'claude-code', workingDir: absDir, model: 'claude-sonnet-4-5' },
      {
        assertEligibleDir: (dir) => dir,
        resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
      },
    );
    expect(getSessionWorkspaceIdentity('session-no-confirm')).toBeUndefined();
    expect(readRegistry({ dataOwnerId: 'owner-fixture-1', ownerRoot }).status).toBe('missing');
  });

  it('fails closed on a mixed registry_only transaction without injecting preparedMemorySession', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    await createLocalAlias({
      dataOwnerId: 'owner-fixture-1',
      ownerRoot,
      absDir,
      confirmed: true,
    });
    await writeFile(
      path.join(ownerRoot, 'workspace-registry-transaction-v1.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: '33333333-3333-4333-8333-333333333333',
        operationKind: 'registry_only',
        expectedRegistryGeneration: 'reg-0',
        expectedProviderConfigGeneration: 'settings-side-unpublished-v1',
        intendedRegistryGeneration: 'reg-1',
        intendedProviderConfigGeneration: 'settings-side-unpublished-v1',
        registryDigestBefore: 'a'.repeat(64),
        providerSettingsDigestBefore: '0'.repeat(64),
        registryDigestAfter: 'b'.repeat(64),
        providerSettingsDigestAfter: '0'.repeat(64),
        state: 'prepared',
      })}\n`,
      'utf8',
    );
    await expect(
      attachSessionWorkspaceIdentity(
        'session-mixed-txn',
        { agentKind: 'claude-code', workingDir: absDir, model: 'claude-sonnet-4-5' },
        {
          assertEligibleDir: (dir) => dir,
          resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(getSessionWorkspaceIdentity('session-mixed-txn')).toBeUndefined();
  });

  it('fails closed on a corrupt registry and keeps the file', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    const file = path.join(ownerRoot, 'workspace-identity-registry-v1.json');
    await writeFile(file, '{not-json', 'utf8');
    await expect(
      attachSessionWorkspaceIdentity(
        'session-bad',
        { agentKind: 'claude-code', workingDir: absDir, model: 'claude-sonnet-4-5' },
        {
          assertEligibleDir: (dir) => dir,
          resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(file, 'utf8')).toBe('{not-json');
  });

  it('forgets the snapshot on close even if later worktree cleanup is skipped', async () => {
    rememberSessionWorkspaceIdentity('session-close', {
      canonicalWorkspaceId: '11111111-1111-4111-8111-111111111111',
      locatorDigest: 'a'.repeat(64),
    });
    forgetSessionWorkspaceIdentity('session-close');
    expect(getSessionWorkspaceIdentity('session-close')).toBeUndefined();
  });

  it('skips remoteHostId even when workingDir looks local', async () => {
    const lookup = vi.fn();
    await attachSessionWorkspaceIdentity(
      'session-remote',
      {
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
        remoteHostId: 'host-1',
      },
      { lookup },
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(getSessionWorkspaceIdentity('session-remote')).toBeUndefined();
  });

  it('treats WORKSPACE_IDENTITY_REQUIRED from readRegistry as skip, not create failure', async () => {
    await attachSessionWorkspaceIdentity(
      'session-no-owner-read',
      { agentKind: 'claude-code', workingDir: '/tmp/project', model: 'claude-sonnet-4-5' },
      {
        assertEligibleDir: (dir) => dir,
        resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot: '/tmp/owner' }),
        read: () => {
          throw new XdtPrepareError('WORKSPACE_IDENTITY_REQUIRED', 'dataOwnerId is required');
        },
        lookup: vi.fn(),
      },
    );
    expect(getSessionWorkspaceIdentity('session-no-owner-read')).toBeUndefined();
  });

  it('treats UNSUPPORTED_CAPABILITY as skip, not create failure', async () => {
    await attachSessionWorkspaceIdentity(
      'session-worktree',
      { agentKind: 'claude-code', workingDir: '/repo/.cindy-worktrees/x', model: 'claude-sonnet-4-5' },
      {
        assertEligibleDir: () => {
          throw createIpcError('UNSUPPORTED_CAPABILITY', 'worktree');
        },
        lookup: vi.fn(),
      },
    );
    expect(getSessionWorkspaceIdentity('session-worktree')).toBeUndefined();
  });

  it('no-ops when the current production prepared session is already present', async () => {
    const lookup = vi.fn();
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    await publishWorkspaceMemoryProviderOverride({
      dataOwnerId: 'owner-fixture-1',
      ownerRoot,
      canonicalWorkspaceId: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
      provider: 'xdt',
    });
    const settings = await loadMemoryProviderSettings({ dataOwnerId: 'owner-fixture-1', ownerRoot });
    rememberSessionWorkspaceIdentity('session-fixture', {
      canonicalWorkspaceId: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
      locatorDigest: 'a'.repeat(64),
    });
    await attachSessionWorkspaceIdentity(
      'session-fixture',
      {
        agentKind: 'claude-code',
        workingDir: '/tmp/fixture',
        model: 'claude-sonnet-4-5',
        preparedMemorySession: {
          preparedMemorySessionId: 'prep',
          binding: {
            provider: 'xdt',
            canonicalWorkspaceId: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
            configGeneration: settings.settings?.configGeneration,
          },
        } as never,
      },
      {
        lookup,
        resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
      },
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(getSessionWorkspaceIdentity('session-fixture')?.canonicalWorkspaceId).toBe(
      'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
    );
  });

  it('clears a previous UUID when resume workingDir no longer matches', async () => {
    rememberSessionWorkspaceIdentity('session-resume', {
      canonicalWorkspaceId: '11111111-1111-4111-8111-111111111111',
      locatorDigest: 'a'.repeat(64),
    });
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    await attachSessionWorkspaceIdentity(
      'session-resume',
      { agentKind: 'claude-code', workingDir: absDir, model: 'claude-sonnet-4-5' },
      {
        assertEligibleDir: (dir) => dir,
        resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
      },
    );
    expect(getSessionWorkspaceIdentity('session-resume')).toBeUndefined();
  });

  it('does not import alias minting or production xdt prepare', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../attach-session-workspace-identity.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/\bcreateLocalAlias\b/);
    expect(src).not.toMatch(/\bprepareMemorySession\b/);
    expect(src).not.toMatch(/\bMemoryStore\b/);
  });

  it('wires attach before persisted orca start and forgets identity outside rehydrate suppression', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
    const attach = src.indexOf('await attachSessionWorkspaceIdentity(sessionId, opts);');
    const persisted = src.indexOf('await preparePersistedOrcaSessionStart(sessionId, opts as MakerSessionCreateOpts);');
    const onClose = src.indexOf('onClose: async (sessionId) => {');
    const forget = src.indexOf('forgetSessionWorkspaceIdentity(sessionId);', onClose);
    const suppression = src.indexOf('rehydrateCloseSuppression.runOnCloseSideEffects(sessionId', onClose);
    const prepareReadonly = src.indexOf('await prepareReadonlyXdtSession(sessionId, opts');
    const forgetPrepared = src.indexOf('forgetPreparedMemorySessionForSessionId(sessionId);', onClose);
    expect(attach).toBeGreaterThan(0);
    expect(prepareReadonly).toBeGreaterThan(attach);
    expect(persisted).toBeGreaterThan(prepareReadonly);
    expect(forget).toBeGreaterThan(onClose);
    expect(forgetPrepared).toBeGreaterThan(forget);
    expect(suppression).toBeGreaterThan(forgetPrepared);
    expect(src).not.toMatch(/opts\.memoryBinding\s*=/);
    expect(src).not.toMatch(/opts\.memoryProviderRequested\s*=/);
    expect(src).not.toMatch(/forgetPreparedMemorySession\(sessionId\)/);
  });
});

describe('Maker.createSession with attach hook', () => {
  it('succeeds for an unregistered directory and keeps preparedMemorySession undefined', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    const startSession = async (opts: CreateSessionOptions) => {
      expect(opts.preparedMemorySession).toBeUndefined();
      return createHandle('thread-internal');
    };
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession) },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
          });
        },
      },
    });
    await maker.createSession({
      id: 'session-unregistered-maker',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
    });
    expect(getSessionWorkspaceIdentity('session-unregistered-maker')).toBeUndefined();
  });

  it('aborts createSession when the registry file is unreadable', async () => {
    const ownerRoot = await tempDir('cindy-xdt-attach-owner-');
    const absDir = await tempDir('cindy-xdt-attach-ws-');
    await writeFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), '{not-json', 'utf8');
    const startSession = async () => createHandle('thread-internal');
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession) },
      storage: createStorage(),
      logger: logger(),
      lifecycleHooks: {
        prepareStartOptions: async (sessionId, opts) => {
          await attachSessionWorkspaceIdentity(sessionId, opts, {
            assertEligibleDir: (dir) => dir,
            resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
          });
        },
      },
    });
    await expect(
      maker.createSession({
        id: 'session-bad-maker',
        agentKind: 'claude-code',
        workingDir: absDir,
        model: 'claude-sonnet-4-5',
      }),
    ).rejects.toBeInstanceOf(XdtPrepareError);
    expect(getSessionWorkspaceIdentity('session-bad-maker')).toBeUndefined();
  });
});
