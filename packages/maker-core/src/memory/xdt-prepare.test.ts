/**
 * Host-only xdt prepareMemorySession 段 1：必须真调 memory_index。
 * 测试 UUID / data 树只服务独立 fixture，不读生产 vault 或生产 xdt data。
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MakerMemoryManager } from './manager.js';
import { MemoryError } from './types.js';
import {
  assertCanonicalWorkspaceUuid,
  isXdtMemoryBinding,
  XdtPrepareError,
  type FrozenIndexSnapshotV1,
  type XdtMemoryBindingV1,
} from './xdt-binding.js';
import { nativeSetMemoryIsProof } from './xdt-native-proof.js';
import { prepareMemorySession } from './xdt-prepare.js';
import { assertXdtBindingSchema } from './xdt-schema.js';
import {
  CANONICAL_LIMITS,
  EMPTY_MEMORY_INDEX,
  EMPTY_MEMORY_INDEX_DIGEST,
  assertFrozenIndexSnapshot,
  limitsDigest,
  snapshotToken,
} from './xdt-snapshot-token.js';
import { isolatedCodexStanzaPresent } from './xdt-writable-sources.js';
import type { Logger } from '../interfaces/logger.js';

const FIXTURE_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const FIXTURE_REGISTRATION = '22222222-2222-4222-8222-222222222222';
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PREPARED_SESSION = '44444444-4444-4444-8444-444444444444';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function fixtureBinding(overrides: Partial<XdtMemoryBindingV1> = {}): XdtMemoryBindingV1 {
  return {
    schemaVersion: 1,
    ownerScopeFingerprint: HEX_A,
    ownerEpoch: 'epoch-1',
    configGeneration: 'cfg-1',
    registryGeneration: 'reg-1',
    bindingDigest: HEX_A,
    enabled: true,
    provider: 'xdt',
    canonicalWorkspaceId: FIXTURE_WORKSPACE,
    serverRegistrationId: FIXTURE_REGISTRATION,
    serverRegistrationGeneration: 'gen-1',
    serverRegistrationDigest: HEX_B,
    ...overrides,
  };
}

function emptySnapshot(): FrozenIndexSnapshotV1 {
  const limitsHash = limitsDigest(CANONICAL_LIMITS);
  return {
    schemaVersion: 1,
    token: snapshotToken(EMPTY_MEMORY_INDEX_DIGEST, limitsHash, 0),
    content: EMPTY_MEMORY_INDEX,
    contentDigest: EMPTY_MEMORY_INDEX_DIGEST,
    byteLength: Buffer.byteLength(EMPTY_MEMORY_INDEX, 'utf8'),
    recordCount: 0,
    counts: { excludedNonFacade: 0, v2Compat: 0, v3: 0 },
    limitsDigest: limitsHash,
    remoteFreshness: 'unknown',
  };
}

function nativeOk() {
  return {
    nativeSetResult: { effective: 'immediate' as const },
    nativeObservedStatus: { enabled: false, source: 'host-runtime' as const },
  };
}

function managerStub() {
  const marked: string[] = [];
  return {
    marked,
    makerMemory: {
      markXdtReadOnlyScope(scope: string) {
        marked.push(scope);
      },
    },
  };
}

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emptyIndexSource() {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-xdt-index-'));
  temps.push(root);
  const dataRoot = path.join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  return {
    repoRoot: root,
    dataRoot,
    workspace: FIXTURE_WORKSPACE,
  };
}

async function seedV2ProjectHead(dataRoot: string, workspace: string) {
  const id = 'fixture';
  const directory = path.join(dataRoot, 'records', workspace, id);
  await mkdir(directory, { recursive: true });
  const record = {
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
    device: 'fixture',
    parent_revision: null,
    operation_id: randomUUID(),
    request_digest: HEX_B,
  };
  await writeFile(path.join(directory, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

describe('empty MEMORY.md golden', () => {
  it('matches Cindy storage.ts empty join (69 bytes / known digest)', () => {
    expect(Buffer.byteLength(EMPTY_MEMORY_INDEX, 'utf8')).toBe(69);
    expect(createHash('sha256').update(EMPTY_MEMORY_INDEX, 'utf8').digest('hex')).toBe(
      EMPTY_MEMORY_INDEX_DIGEST,
    );
    expect(EMPTY_MEMORY_INDEX_DIGEST).toBe(
      '352121ce6932565371ac0a127dc3eea378579c00941c6a7c164a8d4c88eb9c3c',
    );
  });
});

describe('prepareMemorySession fixture lane', () => {
  it('issues XdtMemoryBindingV1 from memory_index on an independent temp tree', async () => {
    const stub = managerStub();
    const prepared = await prepareMemorySession({
      agentKind: 'claude-code',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      preparedMemorySessionId: PREPARED_SESSION,
      indexSource: await emptyIndexSource(),
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: stub.makerMemory,
      ...nativeOk(),
    });
    expect(isXdtMemoryBinding(prepared.binding)).toBe(true);
    expect(prepared.indexSnapshot.content).toBe(EMPTY_MEMORY_INDEX);
    expect(prepared.nativeMemoryProof.observedState).toBe('disabled');
    expect(prepared.nativeMemoryProof.disabledAt.endsWith('Z')).toBe(true);
    expect(stub.marked).toEqual(['/tmp/xdt-fixture-repo']);
  });

  it('projects a non-empty v2 head from MemoryStore.index() without rebuilding MEMORY.md from get()', async () => {
    const stub = managerStub();
    const indexSource = await emptyIndexSource();
    await seedV2ProjectHead(indexSource.dataRoot, FIXTURE_WORKSPACE);
    const { createXdtMemoryIndexClient } = await import('./xdt-index.js');
    const storeIndex = await createXdtMemoryIndexClient(indexSource).index();
    const prepared = await prepareMemorySession({
      agentKind: 'claude-code',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      preparedMemorySessionId: PREPARED_SESSION,
      indexSource,
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: stub.makerMemory,
      ...nativeOk(),
    });
    expect(prepared.indexSnapshot.content).toBe(storeIndex.content);
    expect(prepared.indexSnapshot.content).toContain('project_fixture.md');
    expect(prepared.indexSnapshot.content).not.toBe(EMPTY_MEMORY_INDEX);
    expect(prepared.records.map((row) => row.filename)).toEqual(['project_fixture.md']);
    await expect(prepared.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ filename: 'project_fixture.md' }),
    ]);
    await expect(prepared.sessionStore.read('project_fixture.md')).resolves.toMatchObject({
      filename: 'project_fixture.md',
      body: 'fixture body',
    });
  });

  it('rejects a handwritten FrozenIndexSnapshotV1.content as the memory_index result', async () => {
    const stub = managerStub();
    const snapshot = emptySnapshot();
    snapshot.content = '# Memory Index\n\n_(handwritten — not from memory_index)_\n';
    snapshot.contentDigest = createHash('sha256').update(snapshot.content, 'utf8').digest('hex');
    snapshot.byteLength = Buffer.byteLength(snapshot.content, 'utf8');
    snapshot.token = snapshotToken(snapshot.contentDigest, snapshot.limitsDigest, 0);
    await expect(
      prepareMemorySession({
        agentKind: 'claude-code',
        sessionInstanceId: SESSION_INSTANCE,
        binding: fixtureBinding(),
        isolatedStanzaPresent: true,
        indexClient: { index: async () => snapshot },
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: stub.makerMemory,
        ...nativeOk(),
      }),
    ).rejects.toThrowError(/forbids indexClient|memory_index|caller-supplied snapshot/);
  });

  it('ignores a digest-valid handwritten indexClient when indexSource is present and still uses MemoryStore.index()', async () => {
    const stub = managerStub();
    const indexSource = await emptyIndexSource();
    await seedV2ProjectHead(indexSource.dataRoot, FIXTURE_WORKSPACE);
    const handwritten = emptySnapshot();
    const prepared = await prepareMemorySession({
      agentKind: 'claude-code',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      indexSource,
      indexClient: { index: async () => handwritten },
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: stub.makerMemory,
      ...nativeOk(),
    });
    expect(prepared.indexSnapshot.content).not.toBe(handwritten.content);
    expect(prepared.indexSnapshot.content).toContain('project_fixture.md');
  });

  it('projects extraReadWorkspaces basename records while binding stays UUID', async () => {
    const stub = managerStub();
    const indexSource = await emptyIndexSource();
    await seedV2ProjectHead(indexSource.dataRoot, 'legacy_basename');
    const prepared = await prepareMemorySession({
      agentKind: 'claude-code',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      preparedMemorySessionId: PREPARED_SESSION,
      indexSource: {
        ...indexSource,
        extraReadWorkspaces: ['legacy_basename'],
      },
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: stub.makerMemory,
      ...nativeOk(),
    });
    expect(prepared.binding.canonicalWorkspaceId).toBe(FIXTURE_WORKSPACE);
    expect(prepared.indexSnapshot.content).toContain('project_fixture.md');
    expect(prepared.records.map((row) => row.filename)).toEqual(['project_fixture.md']);
    await expect(prepared.sessionStore.read('project_fixture.md')).resolves.toMatchObject({
      body: 'fixture body',
    });
  });

  it('projects extra-only records by snapshot filename when two extra roots share no filename', async () => {
    const stub = managerStub();
    const indexSource = await emptyIndexSource();
    await seedV2ProjectHead(indexSource.dataRoot, 'legacy_a');
    const secondDir = path.join(indexSource.dataRoot, 'records', 'legacy_b', 'other');
    await mkdir(secondDir, { recursive: true });
    await writeFile(
      path.join(secondDir, 'other.json'),
      `${JSON.stringify({
        schema_version: 2,
        id: 'other',
        key: 'legacy_b/other',
        title: 'Other',
        description: 'second extra root',
        content: 'other body',
        kind: 'project',
        scope: 'workspace',
        workspace: 'legacy_b',
        tags: [],
        source_harness: 'cindy',
        source_ref: null,
        archived: false,
        archive_reason: null,
        updated_at: '2026-09-16T00:00:00.000Z',
        device: 'fixture',
        parent_revision: null,
        operation_id: randomUUID(),
        request_digest: HEX_B,
      }, null, 2)}\n`,
      'utf8',
    );
    const prepared = await prepareMemorySession({
      agentKind: 'claude-code',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      preparedMemorySessionId: PREPARED_SESSION,
      indexSource: {
        ...indexSource,
        extraReadWorkspaces: ['legacy_a', 'legacy_b'],
      },
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: stub.makerMemory,
      ...nativeOk(),
    });
    expect(prepared.records.map((row) => row.filename).sort()).toEqual([
      'project_fixture.md',
      'project_other.md',
    ]);
    await expect(prepared.sessionStore.read('project_other.md')).resolves.toMatchObject({
      body: 'other body',
    });
  });

  it('rejects caller-supplied snapshot.content instead of calling memory_index', async () => {
    const stub = managerStub();
    await expect(
      prepareMemorySession({
        agentKind: 'claude-code',
        sessionInstanceId: SESSION_INSTANCE,
        binding: fixtureBinding(),
        isolatedStanzaPresent: true,
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: stub.makerMemory,
        ...nativeOk(),
        ...( { snapshot: emptySnapshot() } as object ),
      } as never),
    ).rejects.toThrowError(/memory_index|caller-supplied snapshot/);
  });

  it('rejects Cindy Codex xdt enabled prepare while isolated stanza remains', async () => {
    const stub = managerStub();
    await expect(
      prepareMemorySession({
        agentKind: 'codex',
        sessionInstanceId: SESSION_INSTANCE,
        binding: fixtureBinding(),
        isolatedStanzaPresent: true,
        indexSource: await emptyIndexSource(),
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: stub.makerMemory,
        ...nativeOk(),
      }),
    ).rejects.toThrowError(/DUPLICATE_WRITABLE_MEMORY_SOURCE/);
  });

  it('allows Claude fixture prepare while the same isolated Codex stanza is present', async () => {
    expect(isolatedCodexStanzaPresent('[mcp_servers.xdt-memory]\nurl="http://127.0.0.1"')).toBe(true);
    const stub = managerStub();
    await expect(
      prepareMemorySession({
        agentKind: 'claude-code',
        sessionInstanceId: SESSION_INSTANCE,
        binding: fixtureBinding(),
        isolatedStanzaPresent: true,
        indexSource: await emptyIndexSource(),
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: stub.makerMemory,
        ...nativeOk(),
      }),
    ).resolves.toMatchObject({ binding: expect.objectContaining({ provider: 'xdt' }) });
  });

  it('rejects basename / empty namespace as canonical workspace id', () => {
    expect(() => assertCanonicalWorkspaceUuid('claude_obsidian_work')).toThrowError(
      /WORKSPACE_IDENTITY_REQUIRED/,
    );
    expect(() => assertCanonicalWorkspaceUuid('')).toThrowError(/WORKSPACE_IDENTITY_REQUIRED/);
  });

  it('does not treat setMemory(false) success as NativeMemoryDisabledProofV1', async () => {
    expect(
      nativeSetMemoryIsProof(
        { effective: 'immediate' },
        { enabled: true, source: 'host-runtime' },
      ),
    ).toBe(false);
    expect(
      nativeSetMemoryIsProof(
        { effective: 'unsupported' },
        { enabled: false, source: 'host-runtime' },
      ),
    ).toBe(false);
    expect(
      nativeSetMemoryIsProof(
        { effective: 'next-session' },
        { enabled: true, source: 'host-runtime' },
      ),
    ).toBe(false);
    const stub = managerStub();
    await expect(
      prepareMemorySession({
        agentKind: 'claude-code',
        sessionInstanceId: SESSION_INSTANCE,
        binding: fixtureBinding(),
        isolatedStanzaPresent: false,
        indexSource: await emptyIndexSource(),
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: stub.makerMemory,
        nativeSetResult: { effective: 'immediate' },
        nativeObservedStatus: { enabled: true, source: 'host-runtime' },
      }),
    ).rejects.toThrowError(/NATIVE_MEMORY_PROOF_INVALID/);
  });

  it('rejects a snapshot whose token was not recomputed by Host snapshotToken()', () => {
    const snapshot = emptySnapshot();
    snapshot.token = 'idx1_not-recomputed';
    expect(() => assertFrozenIndexSnapshot(snapshot)).toThrowError(/INDEX_SNAPSHOT_MISMATCH/);
  });

  it('rejects InternalMemoryBindingV1 as prepare success binding', async () => {
    const stub = managerStub();
    await expect(
      prepareMemorySession({
        agentKind: 'claude-code',
        sessionInstanceId: SESSION_INSTANCE,
        binding: {
          ...fixtureBinding(),
          provider: 'internal',
        } as unknown as XdtMemoryBindingV1,
        isolatedStanzaPresent: false,
        indexSource: await emptyIndexSource(),
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: stub.makerMemory,
        ...nativeOk(),
      }),
    ).rejects.toBeInstanceOf(XdtPrepareError);
  });

  it('rejects bindings missing registration digest or ownerEpoch', () => {
    expect(isXdtMemoryBinding({ ...fixtureBinding(), serverRegistrationDigest: undefined })).toBe(false);
    expect(isXdtMemoryBinding({ ...fixtureBinding(), ownerEpoch: '' })).toBe(false);
    expect(() =>
      assertXdtBindingSchema({ ...fixtureBinding(), ownerEpoch: undefined }),
    ).toThrowError(/schema rejected/);
  });

  it('rejects ISO offset other than Z on native proof', async () => {
    const stub = managerStub();
    const { freezeUtcZ } = await import('./xdt-native-proof.js');
    expect(() => freezeUtcZ('2026-09-16T00:00:00+00:00')).not.toThrow();
    expect(freezeUtcZ('2026-09-16T00:00:00+00:00').endsWith('Z')).toBe(true);
    await expect(
      prepareMemorySession({
        agentKind: 'claude-code',
        sessionInstanceId: SESSION_INSTANCE,
        binding: fixtureBinding(),
        isolatedStanzaPresent: true,
        indexSource: await emptyIndexSource(),
        xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
        makerMemory: stub.makerMemory,
        ...nativeOk(),
      }),
    ).resolves.toMatchObject({
      nativeMemoryProof: expect.objectContaining({ disabledAt: expect.stringMatching(/Z$/) }),
    });
  });
});

describe('H5 markXdtReadOnlyScope', () => {
  it('prepare then manager.write(xdtScope) is red', async () => {
    const manager = new MakerMemoryManager({
      basePath: '/tmp/maker-memory-xdt-h5',
      sqliteFactory: () => {
        throw new Error('xdt write must fail before opening sqlite');
      },
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
    });
    await prepareMemorySession({
      agentKind: 'pi',
      sessionInstanceId: SESSION_INSTANCE,
      binding: fixtureBinding(),
      isolatedStanzaPresent: true,
      indexSource: await emptyIndexSource(),
      xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
      makerMemory: manager,
      ...nativeOk(),
    });
    await expect(
      manager.write('/tmp/xdt-fixture-repo', {
        type: 'digest',
        name: 'digest-x',
        title: 'no',
        description: 'must not persist',
        body: 'nope',
        mode: 'create',
      }),
    ).rejects.toBeInstanceOf(MemoryError);
  });
});

describe('records must match snapshot', () => {
  it('rejects empty snapshot paired with a project_fixture record', async () => {
    const { assertRecordsMatchSnapshot } = await import('./xdt-index.js');
    expect(() =>
      assertRecordsMatchSnapshot(emptySnapshot(), [
        {
          filename: 'project_fixture.md',
          type: 'project',
          name: 'fixture',
          title: 'Fixture',
          description: 'isolated fixture record',
          key: 'project/fixture',
          revision: `sha256:${HEX_A}`,
          body: 'fixture body',
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
      ]),
    ).toThrowError(/INDEX_SNAPSHOT_MISMATCH/);
  });
});

describe('M5 isolated Codex stanza path', () => {
  it('does not default-read ~/.codex/config.toml', async () => {
    const { defaultCindyCodexConfigPath, cindyIsolatedCodexConfigPath } = await import(
      './xdt-writable-sources.js'
    );
    expect(() => defaultCindyCodexConfigPath()).toThrowError(/userData\/codex-home/);
    expect(cindyIsolatedCodexConfigPath('/tmp/cindy-user-data')).toBe(
      path.join('/tmp/cindy-user-data', 'codex-home', 'config.toml'),
    );
  });
});
