/**
 * 已开着的 Claude 会话解冻：同一 MCP ctx 引用、先 forget 再 prepare、失败不写回旧 binding。
 * 夹具只用 temp ownerRoot / temp git-data，禁止 Roaming 与生产 records。
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  rememberLiveClaudeMcpContext,
  resetLiveClaudeMcpContextsForTest,
  type PreparedMemorySession,
} from '@cindy/maker-core';
import type { LiziMcpSessionContext } from '@cindy/mcps';

import {
  ensurePreparedXdtForLiveSession,
} from '../ensure-prepared-xdt-for-live-session.js';
import { PRODUCTION_WRITE_WORKSPACE } from '../facade-write-target.js';
import { FACADE_INVOCATION_LEDGER_DIR } from '../facade-invocation-ledger.js';
import {
  forgetPreparedMemorySessionForSessionId,
  getPreparedMemorySessionForSessionId,
  rememberPreparedMemorySession,
  bindPreparedMemorySessionToSessionId,
  resetPreparedMemorySessionsForTest,
} from '../prepared-memory-sessions.js';
import {
  rememberSessionWorkspaceIdentity,
  resetSessionWorkspaceIdentityForTest,
} from '../session-workspace-identity.js';
import { publishWorkspaceMemoryProviderOverride } from './publish-workspace-override.js';

const OWNER = 'owner-fixture-ensure';
const SESSION_ID = 'session-ensure-live';
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const OLD_PREPARED = '44444444-4444-4444-8444-444444444444';
const NEW_PREPARED = '55555555-5555-4555-8555-555555555555';

const temps: string[] = [];

afterEach(async () => {
  resetLiveClaudeMcpContextsForTest();
  resetPreparedMemorySessionsForTest();
  resetSessionWorkspaceIdentityForTest();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function prepared(id: string, generation: string): PreparedMemorySession {
  return {
    preparedMemorySessionId: id,
    binding: {
      schemaVersion: 1,
      ownerScopeFingerprint: 'a'.repeat(64),
      ownerEpoch: 'epoch-1',
      configGeneration: generation,
      registryGeneration: 'reg-1',
      bindingDigest: 'a'.repeat(64),
      enabled: true,
      provider: 'xdt',
      canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
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
      preparedMemorySessionId: id,
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
      async write() { throw new Error('frozen write must not be called'); },
      async delete() {},
      async consolidate() { return { ok: true as const, filename: '', deletedSources: [] }; },
    },
    records: [],
  };
}

function liveCtx(old: PreparedMemorySession): LiziMcpSessionContext {
  return {
    agentKind: 'claude-code',
    workingDir: '/tmp/xdt-fixture-repo',
    sessionId: SESSION_ID,
    sessionInstanceId: SESSION_INSTANCE,
    memoryBinding: old.binding,
    preparedMemorySessionId: old.preparedMemorySessionId,
    preparedMemorySession: old,
  };
}

describe('ensurePreparedXdtForLiveSession', () => {
  it('mutates the registered live ctx with the replacement prepared session', async () => {
    const ownerRoot = await tempDir('cindy-ensure-live-owner-');
    expect(ownerRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    await publishWorkspaceMemoryProviderOverride({
      dataOwnerId: OWNER,
      ownerRoot,
      canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
      provider: 'xdt',
    });
    const old = prepared(OLD_PREPARED, 'cfg-old');
    const next = prepared(NEW_PREPARED, 'cfg-new');
    rememberPreparedMemorySession(old);
    bindPreparedMemorySessionToSessionId(SESSION_ID, OLD_PREPARED);
    const ctx = liveCtx(old);
    rememberLiveClaudeMcpContext(SESSION_ID, ctx as never);
    const forgotten: string[] = [];
    const result = await ensurePreparedXdtForLiveSession(SESSION_ID, {
      getLiveContext: () => ctx as never,
      getOwner: () => ({ dataOwnerId: OWNER, ownerRoot }),
      attach: async (sessionId) => {
        rememberSessionWorkspaceIdentity(sessionId, {
          canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
          locatorDigest: 'a'.repeat(64),
        });
      },
      loadSettings: async () => ({
        status: 'readable',
        settings: {
          schemaVersion: 1,
          defaultProvider: 'internal',
          workspaceOverrides: { [PRODUCTION_WRITE_WORKSPACE]: 'xdt' },
          configGeneration: 'cfg-new',
        },
      }) as never,
      getPreparedForSession: () => getPreparedMemorySessionForSessionId(SESSION_ID),
      forgetPreparedForSession: (id) => {
        forgotten.push(id);
        forgetPreparedMemorySessionForSessionId(id);
      },
      prepare: async (_sessionId, opts) => {
        expect(forgotten).toEqual([SESSION_ID]);
        expect(ctx.memoryBinding).toBeUndefined();
        expect(ctx.preparedMemorySessionId).toBeUndefined();
        rememberPreparedMemorySession(next);
        bindPreparedMemorySessionToSessionId(SESSION_ID, NEW_PREPARED);
        opts.preparedMemorySession = next;
      },
    });
    expect(result.status).toBe('ready');
    expect(ctx.preparedMemorySessionId).toBe(NEW_PREPARED);
    expect(ctx.preparedMemorySession).toBe(next);
    expect(ctx.memoryBinding?.configGeneration).toBe('cfg-new');
    expect(ctx.memoryBinding).toBe(next.binding);
  });

  it('does not restore the old binding when the replacement prepare fails', async () => {
    const ownerRoot = await tempDir('cindy-ensure-fail-owner-');
    const old = prepared(OLD_PREPARED, 'cfg-old');
    rememberPreparedMemorySession(old);
    bindPreparedMemorySessionToSessionId(SESSION_ID, OLD_PREPARED);
    const ctx = liveCtx(old);
    rememberLiveClaudeMcpContext(SESSION_ID, ctx as never);
    await expect(ensurePreparedXdtForLiveSession(SESSION_ID, {
      getLiveContext: () => ctx as never,
      getOwner: () => ({ dataOwnerId: OWNER, ownerRoot }),
      attach: async (sessionId) => {
        rememberSessionWorkspaceIdentity(sessionId, {
          canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
          locatorDigest: 'a'.repeat(64),
        });
      },
      loadSettings: async () => ({
        status: 'readable',
        settings: {
          schemaVersion: 1,
          defaultProvider: 'internal',
          workspaceOverrides: { [PRODUCTION_WRITE_WORKSPACE]: 'xdt' },
          configGeneration: 'cfg-new',
        },
      }) as never,
      prepare: async () => {
        throw new Error('prepare exploded');
      },
    })).rejects.toThrow(/prepare exploded/);
    expect(ctx.memoryBinding).toBeUndefined();
    expect(ctx.preparedMemorySessionId).toBeUndefined();
    expect(ctx.preparedMemorySession).toBeUndefined();
    expect(getPreparedMemorySessionForSessionId(SESSION_ID)).toBeUndefined();
  });

  it('fails closed and forgets Host prepared when the live ctx reference is missing', async () => {
    const ownerRoot = await tempDir('cindy-ensure-missing-ctx-');
    expect(ownerRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    const old = prepared(OLD_PREPARED, 'cfg-old');
    rememberPreparedMemorySession(old);
    bindPreparedMemorySessionToSessionId(SESSION_ID, OLD_PREPARED);
    const forgotten: string[] = [];
    const result = await ensurePreparedXdtForLiveSession(SESSION_ID, {
      getOwner: () => ({ dataOwnerId: OWNER, ownerRoot }),
      getLiveContext: () => undefined,
      forgetPreparedForSession: (id) => {
        forgotten.push(id);
        forgetPreparedMemorySessionForSessionId(id);
      },
      prepare: async () => {
        throw new Error('must not invent a ctx');
      },
    });
    expect(result).toEqual({ status: 'failed', code: 'MAKER_MEMORY_NOT_READY' });
    expect(forgotten).toEqual([SESSION_ID]);
    expect(getPreparedMemorySessionForSessionId(SESSION_ID)).toBeUndefined();
    await expect(stat(path.join(ownerRoot, FACADE_INVOCATION_LEDGER_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
