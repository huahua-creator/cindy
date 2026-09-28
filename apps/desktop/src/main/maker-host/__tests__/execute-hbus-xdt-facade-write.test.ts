/**
 * H-Bus create/update：同 requestId 重放同一 ledger；不同 id 两行；frozen write 不被调用。
 * 生产 UUID 夹具用 temp 树，不写 Roaming。
 */

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveXdtMemoryRoot, type PreparedMemorySession } from '@cindy/maker-core';

import { executeHbusXdtFacadeWrite } from '../execute-hbus-xdt-facade-write.js';
import { PRODUCTION_WRITE_WORKSPACE } from '../facade-write-target.js';
import {
  FACADE_INVOCATION_LEDGER_DIR,
  invocationLedgerRoot,
  readInvocationLedger,
} from '../facade-invocation-ledger.js';
import { publishWorkspaceMemoryProviderOverride } from './publish-workspace-override.js';

const OWNER = 'owner-fixture-hbus';
const SESSION_ID = 'session-hbus';
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PREPARED_SESSION = '44444444-4444-4444-8444-444444444444';
const FIXTURE_SECRET = 'xdt-memory-fixture-capability-v1';
const WRITE_ARGS = {
  type: 'project' as const,
  name: 'hbus_probe',
  title: 'hbus probe',
  description: 'same requestId same ledger',
  body: 'body',
  mode: 'create' as const,
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

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function prepared(workspace: string, frozenWrite: ReturnType<typeof vi.fn>): PreparedMemorySession {
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
      canonicalWorkspaceId: workspace,
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
      agentKind: 'claude-code',
      mechanism: 'claude-fresh-session-native-memory-off-v1',
      serverRegistrationGeneration: 'gen-1',
    },
    sessionStore: {
      async list() { return []; },
      async read() { throw new Error('unused'); },
      async search() { return []; },
      async getIndex() { return ''; },
      async write(...args: unknown[]) { frozenWrite(...args); throw new Error('frozen write'); },
      async delete() {},
      async consolidate() { return { ok: true as const, filename: '', deletedSources: [] }; },
    },
    records: [],
  };
}

describe('executeHbusXdtFacadeWrite', () => {
  it('replays the same ledger row for the same requestId and mints two rows for different ids', async () => {
    const ownerRoot = await tempDir('cindy-hbus-ledger-owner-');
    expect(ownerRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    await publishWorkspaceMemoryProviderOverride({
      dataOwnerId: OWNER,
      ownerRoot,
      canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
      provider: 'xdt',
    });
    const repoRoot = await tempDir('cindy-hbus-ledger-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    const frozenWrite = vi.fn();
    const session = prepared(PRODUCTION_WRITE_WORKSPACE, frozenWrite);
    const owner = { dataOwnerId: OWNER, ownerRoot };
    const ctx = {
      agentKind: 'claude-code' as const,
      workingDir: '/tmp/xdt-fixture-repo',
      sessionId: SESSION_ID,
      sessionInstanceId: SESSION_INSTANCE,
      preparedMemorySessionId: PREPARED_SESSION,
      memoryBinding: session.binding,
    };
    const deps = {
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedMemorySession: () => session,
      resolveWriteRoots: () => ({ repoRoot, dataRoot }),
      ensurePrepared: async () => ({ status: 'ready' as const, prepared: session, context: ctx }),
      loadSettings: async () => ({
        status: 'readable' as const,
        settings: { configGeneration: 'cfg-1' },
      }),
      createWriteStore: () => ({
        async get() { return null; },
        async upsert(input: Record<string, unknown>) {
          return {
            shared: true,
            phase: 'shared',
            operation_id: input.operation_id,
            key: String(input.id),
            revision: 'sha256:' + '1'.repeat(64),
            push_verified: true,
          };
        },
      }),
    };
    const first = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'rpc-1',
      mcpSessionId: 'mcp-session-a',
      sessionContext: ctx,
    }, deps);
    expect(parse(first).ok).toBe(true);
    const firstLedger = await readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: SESSION_INSTANCE,
      callId: 'rpc-1',
    });
    const replay = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'rpc-1',
      mcpSessionId: 'mcp-session-a',
      sessionContext: ctx,
    }, deps);
    expect(parse(replay).ok).toBe(true);
    const replayLedger = await readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: SESSION_INSTANCE,
      callId: 'rpc-1',
    });
    expect(replayLedger?.invocationId).toBe(firstLedger?.invocationId);
    expect(replayLedger?.facadeOperationId).toBe(firstLedger?.facadeOperationId);

    const reconnect = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'rpc-1',
      mcpSessionId: 'mcp-session-b',
      sessionContext: ctx,
    }, deps);
    expect(parse(reconnect).ok).toBe(true);
    const reconnectLedger = await readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: SESSION_INSTANCE,
      callId: 'rpc-1',
    });
    expect(reconnectLedger?.invocationId).toBe(firstLedger?.invocationId);
    expect(reconnectLedger?.facadeOperationId).toBe(firstLedger?.facadeOperationId);
    await expect(readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: 'mcp-session-a',
      callId: 'rpc-1',
    })).resolves.toBeUndefined();
    await expect(readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: 'mcp-session-b',
      callId: 'rpc-1',
    })).resolves.toBeUndefined();

    const second = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'rpc-2',
      mcpSessionId: 'mcp-session-a',
      sessionContext: ctx,
    }, deps);
    expect(parse(second).ok).toBe(true);
    const secondLedger = await readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: SESSION_INSTANCE,
      callId: 'rpc-2',
    });
    expect(secondLedger?.invocationId).not.toBe(firstLedger?.invocationId);
    expect(frozenWrite).not.toHaveBeenCalled();
    await expect(stat(path.join(ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).resolves.toBeTruthy();
    expect(repoRoot.replaceAll('\\', '/')).not.toBe(resolveXdtMemoryRoot().replaceAll('\\', '/'));
  });

  it('keeps Pi and remote Codex writes red without minting', async () => {
    const ownerRoot = await tempDir('cindy-hbus-codex-red-');
    const frozenWrite = vi.fn();
    const session = prepared(PRODUCTION_WRITE_WORKSPACE, frozenWrite);
    const deps = {
      getOwner: () => ({ dataOwnerId: OWNER, ownerRoot }),
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedMemorySession: () => session,
      resolveWriteRoots: () => ({ repoRoot: ownerRoot, dataRoot: ownerRoot }),
      ensurePrepared: async () => {
        throw new Error('must not thaw Pi or remote Codex');
      },
    };
    const pi = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'item-pi',
      sessionContext: {
        agentKind: 'pi' as const,
        workingDir: '/tmp/xdt-fixture-repo',
        sessionId: SESSION_ID,
        sessionInstanceId: SESSION_INSTANCE,
        preparedMemorySessionId: PREPARED_SESSION,
        memoryBinding: session.binding,
      },
    }, deps);
    expect(parse(pi)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });

    const remote = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'item-remote',
      sessionContext: {
        agentKind: 'codex' as const,
        workingDir: '/tmp/xdt-fixture-repo',
        sessionId: SESSION_ID,
        sessionInstanceId: SESSION_INSTANCE,
        preparedMemorySessionId: PREPARED_SESSION,
        memoryBinding: session.binding,
        remoteHostId: 'remote-host',
      },
    }, deps);
    expect(parse(remote)).toMatchObject({ ok: false, code: 'XDT_WRITE_NOT_APPLICABLE' });

    const missingInstance = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'item-missing-instance',
      sessionContext: {
        agentKind: 'codex' as const,
        workingDir: '/tmp/xdt-fixture-repo',
        sessionId: SESSION_ID,
        preparedMemorySessionId: PREPARED_SESSION,
        memoryBinding: session.binding,
      },
    }, deps);
    expect(parse(missingInstance)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });
    await expect(stat(path.join(ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(frozenWrite).not.toHaveBeenCalled();
  });

  it('accepts local Codex item.id, replays the same id, and H4-rejects a second item.id before mint', async () => {
    const ownerRoot = await tempDir('cindy-hbus-codex-h4-');
    expect(ownerRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    await publishWorkspaceMemoryProviderOverride({
      dataOwnerId: OWNER,
      ownerRoot,
      canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
      provider: 'xdt',
    });
    const repoRoot = await tempDir('cindy-hbus-codex-h4-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    const frozenWrite = vi.fn();
    const upsert = vi.fn(async (input: Record<string, unknown>) => ({
      shared: true,
      phase: 'shared',
      operation_id: input.operation_id,
      key: String(input.id),
      revision: 'sha256:' + '1'.repeat(64),
      push_verified: true,
    }));
    const session = prepared(PRODUCTION_WRITE_WORKSPACE, frozenWrite);
    const owner = { dataOwnerId: OWNER, ownerRoot };
    const ctx = {
      agentKind: 'codex' as const,
      workingDir: '/tmp/xdt-fixture-repo',
      sessionId: SESSION_ID,
      sessionInstanceId: SESSION_INSTANCE,
      preparedMemorySessionId: PREPARED_SESSION,
      memoryBinding: session.binding,
    };
    const deps = {
      getOwner: () => owner,
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedMemorySession: () => session,
      resolveWriteRoots: () => ({ repoRoot, dataRoot }),
      ensurePrepared: async () => {
        throw new Error('Codex must not thaw live sessions');
      },
      loadSettings: async () => ({
        status: 'readable' as const,
        settings: { configGeneration: 'cfg-1' },
      }),
      createWriteStore: () => ({
        async get() { return null; },
        upsert,
      }),
    };

    const first = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'item-codex-1',
      mcpSessionId: 'mcp-session-a',
      sessionContext: ctx,
    }, deps);
    expect(parse(first).ok).toBe(true);
    const firstLedger = await readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: SESSION_INSTANCE,
      callId: 'item-codex-1',
    });
    expect(firstLedger?.callId).toBe('item-codex-1');

    const replay = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'item-codex-1',
      mcpSessionId: 'mcp-session-b',
      sessionContext: ctx,
    }, deps);
    expect(parse(replay).ok).toBe(true);
    const replayLedger = await readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: SESSION_INSTANCE,
      callId: 'item-codex-1',
    });
    expect(replayLedger?.invocationId).toBe(firstLedger?.invocationId);
    const upsertsAfterReplay = upsert.mock.calls.length;

    const second = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'item-codex-2',
      mcpSessionId: 'mcp-session-a',
      sessionContext: ctx,
    }, deps);
    expect(parse(second)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });
    await expect(readInvocationLedger(owner, {
      threadId: SESSION_ID,
      turnId: SESSION_INSTANCE,
      callId: 'item-codex-2',
    })).resolves.toBeUndefined();
    const ledgerFiles = (await readdir(invocationLedgerRoot(owner))).filter((name) => name.endsWith('.json'));
    expect(ledgerFiles).toHaveLength(1);
    expect(upsert.mock.calls.length).toBe(upsertsAfterReplay);
    expect(frozenWrite).not.toHaveBeenCalled();
  });

  it('rejects a missing sessionInstanceId before minting a ledger row', async () => {
    const ownerRoot = await tempDir('cindy-hbus-missing-instance-');
    expect(ownerRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    const frozenWrite = vi.fn();
    const session = prepared(PRODUCTION_WRITE_WORKSPACE, frozenWrite);
    const result = await executeHbusXdtFacadeWrite({
      args: WRITE_ARGS,
      callId: 'rpc-missing-instance',
      mcpSessionId: 'mcp-session-should-not-become-turn',
      sessionContext: {
        agentKind: 'claude-code' as const,
        workingDir: '/tmp/xdt-fixture-repo',
        sessionId: SESSION_ID,
        preparedMemorySessionId: PREPARED_SESSION,
        memoryBinding: session.binding,
      },
    }, {
      getOwner: () => ({ dataOwnerId: OWNER, ownerRoot }),
      getCapabilitySecret: () => FIXTURE_SECRET,
      getPreparedMemorySession: () => session,
      resolveWriteRoots: () => ({ repoRoot: ownerRoot, dataRoot: ownerRoot }),
      ensurePrepared: async () => {
        throw new Error('must not ensure before sessionInstanceId gate');
      },
    });
    expect(parse(result)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });
    await expect(stat(path.join(ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(frozenWrite).not.toHaveBeenCalled();
  });
});
