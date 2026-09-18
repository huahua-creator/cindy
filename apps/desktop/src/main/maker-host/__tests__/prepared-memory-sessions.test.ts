/**
 * H2 产品入口：temp UUID 树 → memory_index → prepareAndRemember →
 * createSession({ preparedMemorySession })。禁止调用方传入 snapshot.content。
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  Maker,
  type AgentEvent,
  type AgentSessionHandle,
  type BaseAgent,
  type CreateSessionOptions,
  type SessionMeta,
  type SessionStorage,
} from '@cindy/maker-core';

import {
  bindPreparedMemorySessionToSessionId,
  forgetPreparedMemorySession,
  forgetPreparedMemorySessionForSessionId,
  getPreparedMemorySession,
  prepareAndRememberMemorySession,
  resetPreparedMemorySessionsForTest,
} from '../prepared-memory-sessions';
import { readCreateSessionOpts } from '../../maker-ipc/sessionRequest';

const FIXTURE_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const FIXTURE_REGISTRATION = '22222222-2222-4222-8222-222222222222';
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PREPARED_SESSION = '44444444-4444-4444-8444-444444444444';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

const temps: string[] = [];

afterEach(async () => {
  resetPreparedMemorySessionsForTest();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emptyIndexSource() {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-xdt-host-'));
  temps.push(root);
  const dataRoot = path.join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  return { repoRoot: root, dataRoot, workspace: FIXTURE_WORKSPACE };
}

function fixtureBinding() {
  return {
    schemaVersion: 1 as const,
    ownerScopeFingerprint: HEX_A,
    ownerEpoch: 'epoch-1',
    configGeneration: 'cfg-1',
    registryGeneration: 'reg-1',
    bindingDigest: HEX_A,
    enabled: true as const,
    provider: 'xdt' as const,
    canonicalWorkspaceId: FIXTURE_WORKSPACE,
    serverRegistrationId: FIXTURE_REGISTRATION,
    serverRegistrationGeneration: 'gen-1',
    serverRegistrationDigest: HEX_B,
  };
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

describe('Host fixture startup path', () => {
  it('temp UUID tree → memory_index → prepareAndRemember → createSession', async () => {
    const prepared = await prepareAndRememberMemorySession({
      agentKind: 'claude-code',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      preparedMemorySessionId: PREPARED_SESSION,
      nativeSetResult: { effective: 'immediate' },
      nativeObservedStatus: { enabled: false, source: 'host-runtime' },
      indexSource: await emptyIndexSource(),
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: { markXdtReadOnlyScope() {} },
    });

    const seen: CreateSessionOptions[] = [];
    const startSession = async (opts: CreateSessionOptions) => {
      seen.push(opts);
      return createHandle('thread-xdt');
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

    const ipcOpts = readCreateSessionOpts({
      id: 'session-xdt-fixture',
      agentKind: 'claude-code',
      workingDir: '/tmp/xdt-fixture-repo',
      model: 'claude-sonnet-4-5',
      preparedMemorySession: prepared,
    });
    expect(ipcOpts.preparedMemorySession).toBe(prepared);

    await maker.createSession(ipcOpts);
    expect(seen[0]?.preparedMemorySession).toBe(prepared);
    expect(seen[0]?.preparedMemorySession?.indexSnapshot.recordCount).toBe(0);
  });

  it('rejects caller-supplied snapshot.content at prepareAndRemember', async () => {
    await expect(
      prepareAndRememberMemorySession({
        agentKind: 'claude-code',
        sessionInstanceId: SESSION_INSTANCE,
        binding: fixtureBinding(),
        isolatedStanzaPresent: true,
        nativeSetResult: { effective: 'immediate' },
        nativeObservedStatus: { enabled: false, source: 'host-runtime' },
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: { markXdtReadOnlyScope() {} },
        snapshot: { content: '# handwritten\n' },
      } as never),
    ).rejects.toThrow(/memory_index|caller-supplied snapshot/);
  });

  it('forgets prepared by preparedId via the sessionId reverse index, not sessionId', async () => {
    const prepared = await prepareAndRememberMemorySession({
      agentKind: 'claude-code',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      preparedMemorySessionId: PREPARED_SESSION,
      nativeSetResult: { effective: 'immediate' },
      nativeObservedStatus: { enabled: false, source: 'host-runtime' },
      indexSource: await emptyIndexSource(),
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: { markXdtReadOnlyScope() {} },
    });
    bindPreparedMemorySessionToSessionId('business-session', prepared.preparedMemorySessionId);
    expect(getPreparedMemorySession(prepared.preparedMemorySessionId)).toBe(prepared);
    forgetPreparedMemorySession('business-session');
    expect(getPreparedMemorySession(prepared.preparedMemorySessionId)).toBe(prepared);
    forgetPreparedMemorySessionForSessionId('business-session');
    expect(getPreparedMemorySession(prepared.preparedMemorySessionId)).toBeUndefined();
  });
});
