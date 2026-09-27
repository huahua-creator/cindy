/**
 * 前置刀 1b：Host Codex dynamic tool + capability mint + retry 账本。
 * 测试必须注入 temp ownerRoot；禁止写生产 Roaming / dc703d5e UUID。
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadXdtSchemaValidator,
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

function createProvider(owner: { dataOwnerId: string; ownerRoot: string }, prepared: PreparedMemorySession | undefined) {
  return createMemoryFacadeCodexDynamicToolProvider({
    getOwner: () => owner,
    getCapabilitySecret: () => FIXTURE_SECRET,
    getPreparedBySessionId: (sessionId) => (sessionId === SESSION_ID ? prepared : undefined),
    advertiseTools: true,
  });
}

function payload(result: { contentItems: Array<{ type: string; text?: string }> } | undefined): Record<string, unknown> {
  const item = result?.contentItems[0];
  const text = item && 'text' in item ? item.text ?? '' : '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('memory facade Codex dynamic tools', () => {
  it('does not advertise tools in production wiring', async () => {
    const owner = await ownerScope();
    const provider = createMemoryFacadeCodexDynamicToolProvider({
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedBySessionId: () => fixturePrepared(),
    });
    expect(provider.listTools(CONTEXT)).toEqual([]);
    const result = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't-prod', turnId: 'u-prod', callId: 'c-prod' }),
      CONTEXT,
    );
    expect(payload(result)).toEqual(XDT_WRITE_FORBIDDEN);
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

  it('mints with fixture HMAC, claims, and still returns live deny-write', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, fixturePrepared());
    const ids = { threadId: 'thread-a', turnId: 'turn-a', callId: 'call-a' };
    const result = await provider.callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    expect(payload(result)).toEqual(XDT_WRITE_FORBIDDEN);
    expect(result?.success).toBe(false);
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
    const provider = createProvider(owner, fixturePrepared());
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
    const provider = createProvider(owner, fixturePrepared());
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
    await createProvider(owner, fixturePrepared()).callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    const first = await readInvocationLedger(owner, ids);
    await createProvider(owner, fixturePrepared()).callTool(writeCall(WRITE_ARGS, ids), CONTEXT);
    const second = await readInvocationLedger(owner, ids);
    expect(second?.invocationId).toBe(first?.invocationId);
    expect(second?.facadeOperationId).toBe(first?.facadeOperationId);
  });

  it('returns MUTATION_IDENTITY_UNAVAILABLE when the ledger is lost after a claim', async () => {
    const owner = await ownerScope();
    const ids = { threadId: 'thread-lost', turnId: 'turn-lost', callId: 'call-lost' };
    const provider = createProvider(owner, fixturePrepared());
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
    const provider = createProvider(owner, fixturePrepared());
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
    const provider = createProvider(owner, fixturePrepared());
    await provider.callTool(writeCall(WRITE_ARGS, { threadId: 't', turnId: 'u', callId: 'c' }), CONTEXT);
    const journalDir = ownerJournalDir(owner);
    const ledgerRoot = path.join(owner.ownerRoot, FACADE_INVOCATION_LEDGER_DIR);
    expect(ledgerRoot.replaceAll('\\', '/')).not.toContain('/facade-journal/');
    const names = await readdir(journalDir);
    expect(names).not.toContain(FACADE_INVOCATION_LEDGER_DIR);
  });

  it('does not nest journal locks on the first successful mint', async () => {
    const owner = await ownerScope();
    const provider = createProvider(owner, fixturePrepared());
    const result = await provider.callTool(
      writeCall(WRITE_ARGS, { threadId: 't-lock', turnId: 'u-lock', callId: 'c-lock' }),
      CONTEXT,
    );
    expect(payload(result).code).not.toBe('JOURNAL_BUSY');
    expect(payload(result)).toEqual(XDT_WRITE_FORBIDDEN);
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
