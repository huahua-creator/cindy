/**
 * 段 2：owner-scoped 本机一条 alias → opaque UUID。
 * 有 UUID ≠ 启用 xdt。夹具只用独立 temp owner 根 + temp 目录树。
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  Maker,
  isXdtMemoryBinding,
  type AgentEvent,
  type AgentSessionHandle,
  type BaseAgent,
  type CreateSessionOptions,
  type SessionMeta,
  type SessionStorage,
} from '@cindy/maker-core';

import {
  assertMinKindRejectsWorkspaces,
  createLocalAlias,
  lookupLocalAlias,
  readRegistry,
  __testOnly,
} from '../workspace-identity-registry';

const OWNER = 'owner-fixture-1';
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function scope() {
  const ownerRoot = await tempDir('cindy-xdt-owner-');
  const absDir = await tempDir('cindy-xdt-ws-');
  return { dataOwnerId: OWNER, ownerRoot, absDir };
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

describe('workspace identity registry owner gate', () => {
  it('fails before path join or mkdir when dataOwnerId is missing', async () => {
    const ownerRoot = await tempDir('cindy-xdt-no-owner-');
    expect(() =>
      readRegistry({ dataOwnerId: '', ownerRoot }),
    ).toThrowError(/WORKSPACE_IDENTITY_REQUIRED/);
    await expect(
      createLocalAlias({
        dataOwnerId: '',
        ownerRoot,
        absDir: ownerRoot,
        confirmed: true,
      }),
    ).rejects.toThrowError(/WORKSPACE_IDENTITY_REQUIRED/);
    const listing = await import('node:fs/promises').then((fs) => fs.readdir(ownerRoot));
    expect(listing).toEqual([]);
  });
});

describe('workspace identity create/lookup', () => {
  it('creates a UUID v4 and is idempotent for the same realpath', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const first = await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    expect(first.created).toBe(true);
    expect(first.canonicalWorkspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.locatorDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.locatorDigest.startsWith('loc1:')).toBe(false);
    const second = await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    expect(second.canonicalWorkspaceId).toBe(first.canonicalWorkspaceId);
    expect(second.created).toBe(false);
    const looked = await lookupLocalAlias({ dataOwnerId, ownerRoot, absDir });
    expect(looked.canonicalWorkspaceId).toBe(first.canonicalWorkspaceId);
    const utf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    expect(utf8.includes(absDir.replaceAll('\\', '/')) || utf8.includes(absDir)).toBe(false);
    assertMinKindRejectsWorkspaces(utf8.endsWith('\n') ? utf8.slice(0, -1) : utf8);
  });

  it('uses the same digest for a Windows-style case variant of the same realpath', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const first = await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    if (process.platform === 'win32') {
      const variant = absDir.replace(/[a-z]/, (ch) => ch.toUpperCase());
      const again = await createLocalAlias({
        dataOwnerId,
        ownerRoot,
        absDir: variant,
        confirmed: true,
      });
      expect(again.canonicalWorkspaceId).toBe(first.canonicalWorkspaceId);
      expect(again.locatorDigest).toBe(first.locatorDigest);
    }
  });

  it('rejects a dual-bound locator instead of picking one UUID', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const first = await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const file = path.join(ownerRoot, 'workspace-identity-registry-v1.json');
    const otherId = '55555555-5555-4555-8555-555555555555';
    const now = '2026-09-16T00:00:00.000Z';
    const dual = {
      schemaVersion: 1,
      registryGeneration: 'reg-dual',
      workspaces: {
        [first.canonicalWorkspaceId]: {
          canonicalWorkspaceId: first.canonicalWorkspaceId,
          state: 'active',
          createdAt: now,
        },
        [otherId]: { canonicalWorkspaceId: otherId, state: 'active', createdAt: now },
      },
      aliases: {
        [`local-${first.locatorDigest}`]: {
          canonicalWorkspaceId: first.canonicalWorkspaceId,
          locatorKind: 'local',
          locatorDigest: first.locatorDigest,
          boundAt: now,
        },
        [`local-other-${first.locatorDigest.slice(0, 8)}`]: {
          canonicalWorkspaceId: otherId,
          locatorKind: 'local',
          locatorDigest: first.locatorDigest,
          boundAt: now,
        },
      },
    };
    await writeFile(file, `${JSON.stringify(dual)}\n`, 'utf8');
    expect(readRegistry({ dataOwnerId, ownerRoot }).status).toBe('unreadable');
    await expect(
      createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true }),
    ).rejects.toThrowError(/CONFIG_INVALID|WORKSPACE_IDENTITY_CONFLICT|already bound/);
  });

  it('does not mint an id for an unregistered directory', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await expect(
      lookupLocalAlias({ dataOwnerId, ownerRoot, absDir }),
    ).rejects.toMatchObject({ code: 'MAKER_MEMORY_NOT_READY' });
    expect(readRegistry({ dataOwnerId, ownerRoot }).status).toBe('missing');
  });

  it('keeps a corrupt registry file and distinguishes it from missing', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const file = path.join(ownerRoot, 'workspace-identity-registry-v1.json');
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(file, '{not-json', 'utf8');
    expect(readRegistry({ dataOwnerId, ownerRoot }).status).toBe('unreadable');
    expect(readRegistry({ dataOwnerId, ownerRoot }).registry).toBeUndefined();
    await expect(
      createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true }),
    ).rejects.toThrowError(/CONFIG_INVALID/);
    const kept = await readFile(file, 'utf8');
    expect(kept).toBe('{not-json');
  });

  it('rejects basename / cwd text as identity without touching the directory', async () => {
    const { dataOwnerId, ownerRoot } = await scope();
    await expect(
      lookupLocalAlias({ dataOwnerId, ownerRoot, absDir: 'claude_obsidian_work' }),
    ).rejects.toThrow();
  });

  it('fails closed on a mixed before/after registry_only transaction', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const txnPath = path.join(ownerRoot, 'workspace-registry-transaction-v1.json');
    const mixed = {
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
    };
    await writeFile(txnPath, `${JSON.stringify(mixed)}\n`, 'utf8');
    await expect(
      lookupLocalAlias({ dataOwnerId, ownerRoot, absDir }),
    ).rejects.toThrowError(/CONFIG_INVALID/);
  });

  it('returns missing, readable, and unreadable without folding unreadable to empty workspaces', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    expect(readRegistry({ dataOwnerId, ownerRoot }).status).toBe('missing');
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const ok = readRegistry({ dataOwnerId, ownerRoot });
    expect(ok.status).toBe('readable');
    expect(ok.registry?.workspaces).toBeTruthy();
    const file = path.join(ownerRoot, 'workspace-identity-registry-v1.json');
    await writeFile(file, '{not-json', 'utf8');
    const bad = readRegistry({ dataOwnerId, ownerRoot });
    expect(bad.status).toBe('unreadable');
    expect(bad.registry).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('{not-json');
  });

  it('drops a prepared registry_only transaction when digest still matches before', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const registryUtf8 = await readFile(
      path.join(ownerRoot, 'workspace-identity-registry-v1.json'),
      'utf8',
    );
    const body = registryUtf8.endsWith('\n') ? registryUtf8.slice(0, -1) : registryUtf8;
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    const txnPath = path.join(ownerRoot, 'workspace-registry-transaction-v1.json');
    await writeFile(
      txnPath,
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: '33333333-3333-4333-8333-333333333333',
        operationKind: 'registry_only',
        expectedRegistryGeneration: 'reg-empty',
        expectedProviderConfigGeneration: 'settings-side-unpublished-v1',
        intendedRegistryGeneration: 'reg-1',
        intendedProviderConfigGeneration: 'settings-side-unpublished-v1',
        registryDigestBefore: digest,
        providerSettingsDigestBefore: '0'.repeat(64),
        registryDigestAfter: 'b'.repeat(64),
        providerSettingsDigestAfter: '0'.repeat(64),
        state: 'prepared',
      })}\n`,
      'utf8',
    );
    await lookupLocalAlias({ dataOwnerId, ownerRoot, absDir });
    await expect(readFile(txnPath, 'utf8')).rejects.toThrow();
  });

  it('commits a registry_published transaction when digest matches after', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const registryUtf8 = await readFile(
      path.join(ownerRoot, 'workspace-identity-registry-v1.json'),
      'utf8',
    );
    const body = registryUtf8.endsWith('\n') ? registryUtf8.slice(0, -1) : registryUtf8;
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    const txnPath = path.join(ownerRoot, 'workspace-registry-transaction-v1.json');
    await writeFile(
      txnPath,
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: '33333333-3333-4333-8333-333333333333',
        operationKind: 'registry_only',
        expectedRegistryGeneration: 'reg-empty',
        expectedProviderConfigGeneration: 'settings-side-unpublished-v1',
        intendedRegistryGeneration: 'reg-1',
        intendedProviderConfigGeneration: 'settings-side-unpublished-v1',
        registryDigestBefore: 'a'.repeat(64),
        providerSettingsDigestBefore: '0'.repeat(64),
        registryDigestAfter: digest,
        providerSettingsDigestAfter: '0'.repeat(64),
        state: 'registry_published',
      })}\n`,
      'utf8',
    );
    await lookupLocalAlias({ dataOwnerId, ownerRoot, absDir });
    const saved = JSON.parse(await readFile(txnPath, 'utf8')) as { state: string };
    expect(saved.state).toBe('committed');
  });

  it('loads SETTINGS_UNCHANGED_SENTINEL from xdt-memory ≥ 80c9b04', () => {
    expect(__testOnly.settingsSentinel()).toEqual({
      generation: 'settings-side-unpublished-v1',
      digest: '0'.repeat(64),
    });
  });

  it('does not import OverrideSettingsFile or ownerScopedUserDataPath', async () => {
    const src = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace-identity-registry.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"].*override-settings-file/);
    expect(src).not.toMatch(/from ['"].*appSessionState/);
    expect(src).not.toMatch(/createOverrideSettingsFile/);
  });

  it('requires confirmed === true before creating', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await expect(
      createLocalAlias({
        dataOwnerId,
        ownerRoot,
        absDir,
        confirmed: false as unknown as true,
      }),
    ).rejects.toThrowError(/WORKSPACE_IDENTITY_REQUIRED/);
  });
});

describe('half-cutover: UUID does not enable xdt', () => {
  it('createSession on a registered temp dir still has no XdtMemoryBindingV1', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const identity = await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const startSession = async (opts: CreateSessionOptions) => {
      expect(opts.preparedMemorySession).toBeUndefined();
      expect(isXdtMemoryBinding(opts.preparedMemorySession?.binding)).toBe(false);
      return createHandle('thread-internal');
    };
    const logger = {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() {
        return logger;
      },
    };
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession) },
      storage: createStorage(),
      logger,
    });
    await maker.createSession({
      id: 'session-registered-dir',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
    });
    expect(identity.canonicalWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('win32 case variant of a registered dir still has no XdtMemoryBindingV1 on createSession', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const startSession = async (opts: CreateSessionOptions) => {
      expect(opts.preparedMemorySession).toBeUndefined();
      return createHandle('thread-internal');
    };
    const logger = {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() {
        return logger;
      },
    };
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession) },
      storage: createStorage(),
      logger,
    });
    const workingDir = process.platform === 'win32'
      ? absDir.replace(/[a-z]/, (ch) => ch.toUpperCase())
      : absDir;
    await maker.createSession({
      id: 'session-registered-case',
      agentKind: 'claude-code',
      workingDir,
      model: 'claude-sonnet-4-5',
    });
  });
});

describe('locator digest material', () => {
  it('hashes loc1: prefix plus normalized realpath and never stores the prefix', async () => {
    const dir = await tempDir('cindy-xdt-digest-');
    const { digest, normalized } = __testOnly.localLocatorDigest(dir);
    const expected = createHash('sha256').update(`loc1:${normalized}`, 'utf8').digest('hex');
    expect(digest).toBe(expected);
    expect(__testOnly.aliasKeyForDigest(digest)).toBe(`local-${digest}`);
  });
});
