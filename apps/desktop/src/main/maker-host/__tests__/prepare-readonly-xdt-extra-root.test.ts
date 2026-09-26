/**
 * Host extra 读根：独立 temp 树投影 basename 记录。
 * 不得读 Cindy-dev2-xdtseg6 / 生产 userData / 生产 xdt data。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

import { attachSessionWorkspaceIdentity } from '../attach-session-workspace-identity.js';
import {
  extraReadWorkspacesFromWorkingDir,
  prepareReadonlyXdtSession,
} from '../prepare-readonly-xdt-session.js';
import { resetPreparedMemorySessionsForTest } from '../prepared-memory-sessions.js';
import {
  resetSessionWorkspaceIdentityForTest,
} from '../session-workspace-identity.js';
import { createLocalAlias } from '../workspace-identity-registry.js';

const HEX_B = 'b'.repeat(64);
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

function createAgent(input: {
  startSession: (opts: CreateSessionOptions) => Promise<unknown>;
}): BaseAgent {
  let nativeEnabled = true;
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
      memory: { supported: true },
      fork: { supported: false },
      rewind: { supported: false },
      extraDirs: { supported: false },
    },
    startSession: input.startSession,
    async setMemory(enabled: boolean) {
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

async function emptyIndexTree(): Promise<{ repoRoot: string; dataRoot: string }> {
  const repoRoot = await tempDir('cindy-xdt-extra-tree-');
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

function managerStub() {
  return {
    manager: {
      isEnabled: () => true,
      markXdtReadOnlyScope() {},
    },
  };
}

function assertNoProductionPaths(...paths: string[]) {
  for (const value of paths) {
    expect(value).not.toMatch(/claude_obsidian_work/i);
    expect(value).not.toBe('D:/AI/Codex/xdt-memory');
    expect(value.replaceAll('\\', '/')).not.toMatch(/\/AI\/Codex\/xdt-memory\/data$/i);
    expect(value.replaceAll('\\', '/')).not.toMatch(/Cindy-dev2-xdtseg6/i);
  }
}

describe('prepareReadonlyXdtSession extra root', () => {
  it('projects a basename extra root without promoting it to canonical workspace', async () => {
    const ownerRoot = await tempDir('cindy-xdt-extra-owner-');
    const absDir = await tempDir('cindy-xdt-extra-ws-legacy_basename-');
    const created = await createLocalAlias({
      dataOwnerId: OWNER_ID,
      ownerRoot,
      absDir,
      confirmed: true,
    });
    const tree = await emptyIndexTree();
    await seedV2ProjectHead(tree.dataRoot, 'legacy_basename');
    assertNoProductionPaths(tree.repoRoot, tree.dataRoot, absDir, ownerRoot);
    let captured: CreateSessionOptions | undefined;
    const nativeAgent = createAgent({
      startSession: async (opts) => {
        captured = opts;
        return createHandle('thread-extra');
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
              extraReadWorkspaces: ['legacy_basename'],
            }),
            userDataDir: () => ownerRoot,
          });
        },
      },
    });
    await maker.createSession({
      id: 'session-registered-extra',
      agentKind: 'claude-code',
      workingDir: absDir,
      model: 'claude-sonnet-4-5',
      makerMemoryEnabled: true,
    });
    const prepared = captured?.preparedMemorySession;
    expect(prepared?.binding.canonicalWorkspaceId).toBe(created.canonicalWorkspaceId);
    expect(prepared?.indexSnapshot.content).toContain('project_fixture.md');
    expect(prepared?.records.map((row) => row.filename)).toEqual(['project_fixture.md']);
    expect(prepared?.records[0]?.body).toBe('fixture body');
  });

  it('derives extra labels from a confirmed workingDir basename and drops path tricks', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(extraReadWorkspacesFromWorkingDir('D:/vaults/legacy_basename', uuid)).toEqual([
      'legacy_basename',
    ]);
    expect(extraReadWorkspacesFromWorkingDir('D:/vaults/.', uuid)).toEqual([]);
    expect(extraReadWorkspacesFromWorkingDir('D:/vaults/..', uuid)).toEqual([]);
    expect(extraReadWorkspacesFromWorkingDir('.', uuid)).toEqual([]);
    expect(extraReadWorkspacesFromWorkingDir(undefined, uuid)).toEqual([]);
  });
});
