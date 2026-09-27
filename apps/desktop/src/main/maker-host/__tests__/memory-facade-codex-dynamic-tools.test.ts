/**
 * 前置刀 1b：Host Codex dynamic tool + capability mint + retry 账本。
 * 测试必须注入 temp ownerRoot；禁止写生产 Roaming / dc703d5e UUID。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadXdtSchemaValidator,
  resolveXdtMemoryRoot,
  type PreparedMemorySession,
} from '@cindy/maker-core';

import { facadeCapabilityMac, mintFacadeInitialCapability } from '../facade-capability.js';
import {
  callIdentityDigest,
  FACADE_INVOCATION_LEDGER_DIR,
  ledgerPath,
  readInvocationLedger,
} from '../facade-invocation-ledger.js';
import { ownerJournalDir } from '../facade-journal.js';
import {
  composeCodexHostDynamicToolProviders,
  createMemoryFacadeCodexDynamicToolProvider,
  XDT_WRITE_FORBIDDEN,
} from '../memory-facade-codex-dynamic-tools.js';
import { createIOSSimulatorCodexDynamicToolProvider } from '../ios-simulator-codex-dynamic-tools.js';

const OWNER = 'owner-fixture-facade-1b';
const SESSION_ID = 'session-facade-1b';
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PREPARED_SESSION = '44444444-4444-4444-8444-444444444444';
const FIXTURE_SECRET = 'xdt-memory-fixture-capability-v1';
const WRITE_ARGS = {
  type: 'project',
  name: 'facade_1b_probe',
  title: '1b probe',
  description: 'host facade mint probe',
  body: 'deny-write still required',
};

const execFileAsync = promisify(execFile);
const WRITE_WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function assertTempOwnerRoot(ownerRoot: string): void {
  const normalized = ownerRoot.replaceAll('\\', '/');
  expect(normalized).not.toMatch(/AppData\/Roaming\/Cindy/i);
  expect(normalized).not.toMatch(/dc703d5e/i);
}

function fixturePrepared(): PreparedMemorySession {
  return {
    preparedMemorySessionId: PREPARED_SESSION,
    binding: {
      schemaVersion: 1,
      ownerScopeFingerprint: 'a'.repeat(64),
      ownerEpoch: 'epoch-1',
      configGeneration: 'cfg-1',
      registryGeneration: 'reg-1',
      bindingDigest: 'a'.repeat(64),
      enabled: true,
      provider: 'xdt',
      canonicalWorkspaceId: '11111111-1111-4111-8111-111111111111',
      serverRegistrationId: '22222222-2222-4222-8222-222222222222',
      serverRegistrationGeneration: 'gen-1',
      serverRegistrationDigest: 'b'.repeat(64),
    },
    indexSnapshot: {
      schemaVersion: 1,
      token: 'tok',
      content: '# Memory Index\n',
      contentDigest: 'c'.repeat(64),
      byteLength: 16,
      recordCount: 0,
      counts: { excludedNonFacade: 0, v2Compat: 0, v3: 0 },
      limitsDigest: 'd'.repeat(64),
      remoteFreshness: 'unknown',
    },
    nativeMemoryProof: {
      schemaVersion: 1,
      sessionInstanceId: SESSION_INSTANCE,
      preparedMemorySessionId: PREPARED_SESSION,
      ownerScopeFingerprint: 'a'.repeat(64),
      ownerEpoch: 'epoch-1',
      bindingDigest: 'a'.repeat(64),
      disabledAt: '2026-09-16T00:00:00Z',
      observedState: 'disabled',
      observationDigest: 'e'.repeat(64),
      proofDigest: 'f'.repeat(64),
      agentKind: 'codex',
      mechanism: 'codex-fresh-process-native-memory-off-v1',
      serverRegistrationGeneration: 'gen-1',
    },
    sessionStore: {
      async list() { return []; },
      async read() { throw new Error('unused'); },
      async search() { return []; },
      async getIndex() { return ''; },
      async write() { throw new Error('unused'); },
      async delete() {},
      async consolidate() { return { ok: true as const, filename: '', deletedSources: [] }; },
    },
    records: [],
  };
}

const CONTEXT = {
  sessionId: SESSION_ID,
  workingDir: '/repo',
  model: 'qwen/qwen3.8-max-preview',
  providerId: 'xd',
  vendorOptions: {},
};

function writeCall(args: Record<string, unknown>, ids: { threadId: string; turnId: string; callId: string }) {
  return {
    threadId: ids.threadId,
    turnId: ids.turnId,
    callId: ids.callId,
    namespace: null as null,
    tool: 'cindy_memory_facade__call_tool',
    arguments: { name: 'memory_write', args },
  };
}

async function ownerScope() {
  const ownerRoot = await tempDir('cindy-facade-1b-owner-');
  assertTempOwnerRoot(ownerRoot);
  return { dataOwnerId: OWNER, ownerRoot };
}

async function isolatedWriteTarget(workspace = WRITE_WORKSPACE) {
  const repoRoot = await tempDir('cindy-facade-1c-stub-repo-');
  const dataRoot = path.join(repoRoot, 'data');
  await mkdir(dataRoot, { recursive: true });
  return { repoRoot, dataRoot, workspace };
}

function stubWriteStore() {
  return {
    async get() { return null; },
    async upsert(input: Record<string, unknown>) {
      return {
        shared: true,
        phase: 'shared',
        operation_id: input.operation_id,
        key: `${String(input.id)}`,
        revision: 'sha256:' + '1'.repeat(64),
        push_verified: true,
      };
    },
  };
}

function createProvider(
  owner: { dataOwnerId: string; ownerRoot: string },
  prepared: PreparedMemorySession | undefined,
  writeTarget?: { repoRoot: string; dataRoot: string; workspace: string },
) {
  const bound = prepared ? { ...prepared, binding: { ...prepared.binding } } : undefined;
  if (bound && writeTarget) {
    bound.binding.canonicalWorkspaceId = writeTarget.workspace;
  }
  return createMemoryFacadeCodexDynamicToolProvider({
    getOwner: () => owner,
    getCapabilitySecret: () => FIXTURE_SECRET,
    getPreparedBySessionId: (sessionId) => (sessionId === SESSION_ID ? bound : undefined),
    advertiseTools: true,
    ...(writeTarget
      ? {
          getWriteTarget: () => writeTarget,
          createWriteStore: () => stubWriteStore(),
        }
      : {}),
  });
}

function payload(result: { contentItems: Array<{ type: string; text?: string }> } | undefined): Record<string, unknown> {
  const item = result?.contentItems[0];
  const text = item && 'text' in item ? item.text ?? '' : '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('memory facade Codex dynamic tools', () => {
  it('advertises in production wiring but cannot write production disk without a write target', async () => {
    const owner = await ownerScope();
    const constructs: unknown[] = [];
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => fixturePrepared(),
      advertiseTools: true,
      getWriteTarget: () => undefined,
      createWriteStore: (options) => {
        constructs.push(options);
        throw new Error('must not construct MemoryStore');
      },
    });
    expect(provider.listTools(CONTEXT).map((tool) => tool.name)).toEqual([
      'cindy_memory_facade__list_tools',
      'cindy_memory_facade__call_tool',
    ]);
    const listed = await provider.callTool(
      {
        threadId: 't-prod',
        turnId: 'u-prod',
        callId: 'c-list',
        namespace: null,
        tool: 'cindy_memory_facade__list_tools',
        arguments: {},
      },
      CONTEXT,
    );
    expect(payload(listed).tools).toEqual([
      expect.objectContaining({ name: 'memory_write' }),
    ]);
    const result = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't-prod', turnId: 'u-prod', callId: 'c-prod' }),
      CONTEXT,
    );
    expect(payload(result)).toEqual(XDT_WRITE_FORBIDDEN);
    expect(constructs).toEqual([]);
    await expect(stat(path.join(owner.ownerRoot, 'facade-journal'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not advertise tools without a prepared xdt session', () => {
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => ({ dataOwnerId: OWNER, ownerRoot: tmpdir() }),
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => undefined,
      advertiseTools: true,
    });
    expect(provider.listTools(CONTEXT)).toEqual([]);
  });

  it('rejects claim-less calls and does not mint without a prepared session', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, undefined);
    const result = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't1', turnId: 'u1', callId: 'c1' }),
      CONTEXT,
    );
    expect(payload(result).code).toBe('FACADE_CAPABILITY_REQUIRED');
    await expect(stat(path.join(owner.ownerRoot, 'facade-journal'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects model-reported invocation identity in args or _meta', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, fixturePrepared());
    const withId = await provider.callTool(
      writeCall({ ...WRITE_ARGS, invocationId: 'model-forged' }, { threadId: 't1', turnId: 'u1', callId: 'c1' }),
      CONTEXT,
    );
    expect(payload(withId).code).toBe('INVALID_ARGS');
    const withMeta = await provider.callTool(
      {
        ...writeCall(WRITE_ARGS, { threadId: 't1', turnId: 'u1', callId: 'c2' }),
        _meta: { capability: { capabilityMac: 'a'.repeat(64) } },
      } as never,
      CONTEXT,
    );
    expect(payload(withMeta).code).toBe('INVALID_ARGS');
    await expect(stat(path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('mints with fixture HMAC, claims, and writes only the injected isolated tree', async () => {
    const owner = await ownerScope();
    const writeTarget = await isolatedWriteTarget();
    const provider = createProvider(owner, fixturePrepared(), writeTarget);
    const ids = { threadId: 'thread-a', turnId: 'turn-a', callId: 'call-a' };
    const result = await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    expect(payload(result).shared).toBe(true);
    expect(result?.success).toBe(true);
    const first = result?.contentItems[0];
    const text = first && 'text' in first ? first.text ?? '' : '';
    expect(text).not.toContain(FIXTURE_SECRET);
    expect(text).not.toMatch(/capabilityMac/);

    const ledger = await readInvocationLedger(owner, ids);
    expect(ledger?.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ledger?.facadeOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ledger?.sessionInstanceId).toBe(SESSION_INSTANCE);
    expect(JSON.stringify(ledger)).not.toContain(FIXTURE_SECRET);

    const schema = loadXdtSchemaValidator();
    const kind = (schema.KIND as { initialCapability?: string }).initialCapability
      ?? 'facade-initial-capability-v1';
    const minted = mintFacadeInitialCapability(
      {
        innerToolName: 'memory_write',
        normalizedArgsDigest: 'a'.repeat(64),
        sessionInstanceId: '11111111-1111-4111-8111-111111111111',
        preparedMemorySessionId: '22222222-2222-4222-8222-222222222222',
        invocationId: 'inv-opaque-1',
        issuerGeneration: 'iss-1',
        issuedAt: '2026-09-16T00:00:00Z',
        expiresAt: '2026-09-16T01:00:00Z',
        nonce: 'nonce-1',
      },
      FIXTURE_SECRET,
    );
    expect(minted.capabilityMac).toBe('6d341578814c172741c546e41c35c06f2ea5b971a9c0318c35dc48c8fb70a485');
    expect(schema.validateUtf8Object({ kind, utf8Bytes: JSON.stringify(minted) }).ok).toBe(true);
    expect(facadeCapabilityMac(minted, Buffer.from('prod-secret-not-fixture'))).not.toBe(minted.capabilityMac);
  });

  it('reuses invocationId and facadeOperationId on the same call identity', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, fixturePrepared(), await isolatedWriteTarget());
    const ids = { threadId: 'thread-b', turnId: 'turn-b', callId: 'call-b' };
    await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    const first = await readInvocationLedger(owner, ids);
    await provider.callTool(writeCall({ ...WRITE_ARGS, mode: 'create' }, ids), CONTEXT);
    const second = await readInvocationLedger(owner, ids);
    expect(second?.invocationId).toBe(first?.invocationId);
    expect(second?.facadeOperationId).toBe(first?.facadeOperationId);
  });

  it('treats the same args with a different callId as a second operation', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, fixturePrepared(), await isolatedWriteTarget());
    await provider.callTool(writeCall(WRITE_ARGS, { threadId: 't', turnId: 'u', callId: 'c-1' }), CONTEXT);
    await provider.callTool(writeCall(WRITE_ARGS, { threadId: 't', turnId: 'u', callId: 'c-2' }), CONTEXT);
    const a = await readInvocationLedger(owner, { threadId: 't', turnId: 'u', callId: 'c-1' });
    const b = await readInvocationLedger(owner, { threadId: 't', turnId: 'u', callId: 'c-2' });
    expect(a?.invocationId).not.toBe(b?.invocationId);
    expect(a?.facadeOperationId).not.toBe(b?.facadeOperationId);
  });

  it('reuses the disk ledger after a Host restart of the provider instance', async () => {
    const owner = await ownerScope();
    const ids = { threadId: 'thread-restart', turnId: 'turn-restart', callId: 'call-restart' };
    const writeTarget = await isolatedWriteTarget();
    await createProvider(owner, fixturePrepared(), writeTarget).callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    const first = await readInvocationLedger(owner, ids);
    await createProvider(owner, fixturePrepared(), writeTarget).callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    const second = await readInvocationLedger(owner, ids);
    expect(second?.invocationId).toBe(first?.invocationId);
    expect(second?.facadeOperationId).toBe(first?.facadeOperationId);
  });

  it('returns MUTATION_IDENTITY_UNAVAILABLE when the ledger is lost after a claim', async () => {
    const owner = await ownerScope();
    const ids = { threadId: 'thread-lost', turnId: 'turn-lost', callId: 'call-lost' };
    const provider = createProvider(owner, fixturePrepared(), await isolatedWriteTarget());
    await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    const digest = callIdentityDigest(ids);
    await rm(ledgerPath(owner, digest), { force: true });
    // sidecar call index remains; lost ledger after claim must not remint.
    const result = await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    expect(payload(result).code).toBe('MUTATION_IDENTITY_UNAVAILABLE');
    const after = await readInvocationLedger(owner, ids);
    expect(after).toBeUndefined();
  });

  it('returns MUTATION_IDENTITY_UNAVAILABLE on ledger digest mix', async () => {
    const owner = await ownerScope();
    const ids = { threadId: 'thread-mix', turnId: 'turn-mix', callId: 'call-mix' };
    const provider = createProvider(owner, fixturePrepared(), await isolatedWriteTarget());
    await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    const file = ledgerPath(owner, callIdentityDigest(ids));
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    raw.callId = 'other-call';
    await writeFile(file, `${JSON.stringify(raw)}\n`, 'utf8');
    const result = await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    expect(payload(result).code).toBe('MUTATION_IDENTITY_UNAVAILABLE');
  });

  it('does not count the retry ledger toward 1a journal capacity', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, fixturePrepared(), await isolatedWriteTarget());
    await provider.callTool(writeCall(WRITE_ARGS, { threadId: 't', turnId: 'u', callId: 'c' }), CONTEXT);
    const journalDir = ownerJournalDir(owner);
    const ledgerRoot = path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR);
    expect(ledgerRoot.replaceAll('\\', '/')).not.toContain('/facade-journal/');
    const names = await readdir(journalDir);
    expect(names).not.toContain(FACADE_INVOCATION_LEDGER_DIR);
  });

  it('does not nest journal locks on the first successful mint', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, fixturePrepared(), await isolatedWriteTarget());
    const result = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't-lock', turnId: 'u-lock', callId: 'c-lock' }),
      CONTEXT,
    );
    expect(payload(result).code).not.toBe('JOURNAL_BUSY');
    expect(payload(result).shared).toBe(true);
  });

  it('rejects append, delete, and consolidate before claim', async () => {
    const owner = await ownerScope();
    const constructs: unknown[] = [];
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => fixturePrepared(),
      advertiseTools: true,
      createWriteStore: (options) => {
        constructs.push(options);
        throw new Error('must not construct');
      },
    });
    const append = await provider.callTool(
      writeCall({ ...WRITE_ARGS, mode: 'append' }, { threadId: 't', turnId: 'u', callId: 'c-append' }),
      CONTEXT,
    );
    expect(payload(append).code).toBe('INVALID_ARGS');
    const consolidate = await provider.callTool(
      {
        threadId: 't',
        turnId: 'u',
        callId: 'c-con',
        namespace: null,
        tool: 'cindy_memory_facade__call_tool',
        arguments: { name: 'memory_consolidate', args: { sources: ['a.md'] } },
      },
      CONTEXT,
    );
    expect(payload(consolidate).code).toBe('INVALID_ARGS');
    const deleted = await provider.callTool(
      {
        threadId: 't',
        turnId: 'u',
        callId: 'c-del',
        namespace: null,
        tool: 'cindy_memory_facade__call_tool',
        arguments: { name: 'memory_delete', args: { filename: 'project_facade_1b_probe.md' } },
      },
      CONTEXT,
    );
    expect(payload(deleted).code).toBe('INVALID_ARGS');
    await expect(stat(path.join(owner.ownerRoot, 'facade-journal'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(constructs).toEqual([]);
  });

  it('rejects missing write-target fields and forbidden workspaces before MemoryStore', async () => {
    const owner = await ownerScope();
    const constructs: unknown[] = [];
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => fixturePrepared(),
      advertiseTools: true,
      getWriteTarget: () => ({ repoRoot: '', dataRoot: '', workspace: '' }),
      createWriteStore: (options) => {
        constructs.push(options);
        throw new Error('must not construct');
      },
    });
    const missing = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't', turnId: 'u', callId: 'c-missing' }),
      CONTEXT,
    );
    expect(payload(missing).code).toBe('WRITE_TARGET_REQUIRED');
    expect(constructs).toEqual([]);
    await expect(stat(path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const bannedRepo = await tempDir('cindy-facade-1c-repo-');
    const bannedData = await tempDir('cindy-facade-1c-data-');
    const forbidden = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => fixturePrepared(),
      advertiseTools: true,
      getWriteTarget: () => ({
        repoRoot: bannedRepo,
        dataRoot: bannedData,
        workspace: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
      }),
      createWriteStore: (options) => {
        constructs.push(options);
        throw new Error('must not construct');
      },
    });
    const banned = await forbidden.callTool(
      writeCall(WRITE_ARGS, { threadId: 't', turnId: 'u', callId: 'c-banned' }),
      CONTEXT,
    );
    expect(payload(banned).code).toBe('WRITE_TARGET_FORBIDDEN');
    expect(constructs).toEqual([]);
  });

  it('does not mint when Host secret storage is unavailable and writes no plaintext secret file', async () => {
    const owner = await ownerScope();
    const { FacadeSecretError, loadHostFacadeCapabilitySecret } = await import('../facade-capability-secret.js');
    expect(() => loadHostFacadeCapabilitySecret({
      isAvailable: () => false,
      read: () => null,
      write: () => true,
      remove: () => ({ success: true }),
      list: () => [],
    })).toThrow(/FACADE_SECRET_UNAVAILABLE/);
    const writeTarget = await isolatedWriteTarget();
    const prepared = fixturePrepared();
    prepared.binding.canonicalWorkspaceId = writeTarget.workspace;
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => {
        throw new FacadeSecretError('safeStorage encryption is unavailable');
      },
      getPreparedBySessionId: () => prepared,
      advertiseTools: true,
      getWriteTarget: () => writeTarget,
      createWriteStore: () => {
        throw new Error('must not construct');
      },
    });
    await expect(stat(path.join(owner.ownerRoot, 'facade-journal'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const result = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't-secret', turnId: 'u-secret', callId: 'c-secret' }),
      CONTEXT,
    );
    expect(payload(result).code).toBe('FACADE_SECRET_UNAVAILABLE');
    await expect(stat(path.join(owner.ownerRoot, 'facade-capability.secret'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.join(owner.ownerRoot, 'facade-journal'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('constructs MemoryStore with injected dataRoot, not production dataRoot', async () => {
    const owner = await ownerScope();
    const writeTarget = await isolatedWriteTarget();
    const prepared = fixturePrepared();
    prepared.binding.canonicalWorkspaceId = writeTarget.workspace;
    const productionData = path.join(resolveXdtMemoryRoot(), 'data');
    const seen: Array<Record<string, unknown>> = [];
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => prepared,
      advertiseTools: true,
      getWriteTarget: () => writeTarget,
      createWriteStore: (options) => {
        seen.push(options);
        return stubWriteStore();
      },
    });
    const result = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't-ctor', turnId: 'u-ctor', callId: 'c-ctor' }),
      CONTEXT,
    );
    expect(payload(result).shared).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(String(options.dataRoot).toLowerCase()).not.toBe(productionData.toLowerCase());
      expect(String(options.dataRoot).toLowerCase()).toBe(writeTarget.dataRoot.toLowerCase());
      expect(String(options.repoRoot).toLowerCase()).toBe(writeTarget.repoRoot.toLowerCase());
    }
  });

  it('creates on an isolated git tree with shared:true and reuses operationId on retry', { timeout: 60_000 }, async () => {
    const owner = await ownerScope();
    const prepared = fixturePrepared();
    prepared.binding.canonicalWorkspaceId = WRITE_WORKSPACE;
    const root = await tempDir('cindy-facade-1c-iso-');
    const remote = path.join(root, 'remote.git');
    const service = path.join(root, 'service');
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote], { windowsHide: true });
    await execFileAsync('git', ['clone', remote, service], { windowsHide: true });
    await execFileAsync('git', ['-C', service, 'config', 'user.name', 'cindy facade 1c'], { windowsHide: true });
    await execFileAsync('git', ['-C', service, 'config', 'user.email', 'cindy-facade-1c@example.invalid'], { windowsHide: true });
    await writeFile(path.join(service, '.gitignore'), '.runtime/\n', 'utf8');
    await mkdir(path.join(service, 'data'), { recursive: true });
    await writeFile(path.join(service, 'data', '.gitkeep'), '', 'utf8');
    await execFileAsync('git', ['-C', service, 'add', '.gitignore', 'data/.gitkeep'], { windowsHide: true });
    await execFileAsync('git', ['-C', service, 'commit', '-m', 'fixture: isolated facade write'], { windowsHide: true });
    await execFileAsync('git', ['-C', service, 'push', '-u', 'origin', 'main'], { windowsHide: true });
    const target = {
      repoRoot: service,
      dataRoot: path.join(service, 'data'),
      workspace: WRITE_WORKSPACE,
    };
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => prepared,
      advertiseTools: true,
      getWriteTarget: () => target,
    });
    const ids = { threadId: 'iso', turnId: 'turn', callId: 'call-iso' };
    const first = await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    expect(payload(first).shared).toBe(true);
    expect(payload(first).operation_id).toMatch(/^[0-9a-f-]{36}$/);
    const ledger = await readInvocationLedger(owner, ids);
    expect(payload(first).operation_id).toBe(ledger?.operationId);
    const second = await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    expect(payload(second).shared).toBe(true);
    expect(payload(second).operation_id).toBe(ledger?.operationId);
    const recordDir = path.join(service, 'data', 'records', WRITE_WORKSPACE, WRITE_ARGS.name);
    const names = await readdir(recordDir);
    expect(names).toEqual([`${ledger?.operationId}.json`]);
    const record = JSON.parse(await readFile(path.join(recordDir, names[0]), 'utf8')) as Record<string, unknown>;
    expect(record.id).toBe(WRITE_ARGS.name);
    expect(record.kind).toBe(WRITE_ARGS.type);
    expect(record.operation_id).toBe(ledger?.operationId);
    expect(JSON.stringify(ledger)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(record)).not.toContain(FIXTURE_SECRET);
    const journalFiles: string[] = [];
    const journalRoot = ownerJournalDir(owner);
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else journalFiles.push(await readFile(full, 'utf8'));
      }
    };
    await walk(journalRoot);
    expect(journalFiles.join('\n')).not.toContain(FIXTURE_SECRET);
    expect(ledger?.expectedRevision).toBeNull();
    const makerMemory = path.join(owner.ownerRoot, 'maker-memory');
    await expect(stat(makerMemory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(path.join('D:/AI/Codex/xdt-memory/data/records/dc703d5e-1ce0-4543-be4d-014cfa3a1955', WRITE_ARGS.name)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(path.join('D:/AI/Codex/xdt-memory/data/records/5fb84df7-8de0-4f74-a7ff-6c7b0850f317', WRITE_ARGS.name)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('composes with iOS without replacing it, and keeps foreign tools undefined', async () => {
    const owner = await ownerScope();
    const composed = composeCodexHostDynamicToolProviders([
      createIOSSimulatorCodexDynamicToolProvider({ deps: { callTool: async () => ({ ok: true }) } }),
      createProvider(owner, fixturePrepared()),
    ]);
    const listed = composed.listTools(CONTEXT).map((tool) => tool.name);
    expect(listed).toContain('cindy_memory_facade__call_tool');
    const foreign = await composed.callTool(
      {
        threadId: 't',
        turnId: 'u',
        callId: 'c',
        namespace: null,
        tool: 'not_a_host_tool',
        arguments: {},
      },
      CONTEXT,
    );
    expect(foreign).toBeUndefined();
  });
});
