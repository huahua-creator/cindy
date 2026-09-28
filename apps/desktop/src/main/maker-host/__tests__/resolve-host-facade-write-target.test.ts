/**
 * 生产 getWriteTarget：dc703d5e + committed settings + Host 注入根。
 * 夹具不得写 Roaming，也不得把真实 checkout 当成功路径。
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveXdtMemoryRoot, type PreparedMemorySession } from '@cindy/maker-core';

import { PRODUCTION_WRITE_WORKSPACE } from '../facade-write-target.js';
import { resolveHostFacadeWriteTarget } from '../resolve-host-facade-write-target.js';
import { publishWorkspaceMemoryProviderOverride } from './publish-workspace-override.js';

const temps: string[] = [];
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PREPARED_SESSION = '44444444-4444-4444-8444-444444444444';

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function prepared(workspace: string): PreparedMemorySession {
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
      async write() { throw new Error('frozen write must not be called'); },
      async delete() {},
      async consolidate() { return { ok: true as const, filename: '', deletedSources: [] }; },
    },
    records: [],
  };
}

describe('resolveHostFacadeWriteTarget', () => {
  it('returns undefined when settings are missing', async () => {
    const ownerRoot = await tempDir('cindy-hbus-missing-settings-');
    expect(ownerRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    const repoRoot = await tempDir('cindy-hbus-missing-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    const target = await resolveHostFacadeWriteTarget({
      prepared: prepared(PRODUCTION_WRITE_WORKSPACE),
      owner: { dataOwnerId: 'owner-fixture', ownerRoot },
      repoRoot,
      dataRoot,
    });
    expect(target).toBeUndefined();
  });

  it('returns Host-injected temp roots for dc703d5e after committed override', async () => {
    const ownerRoot = await tempDir('cindy-hbus-committed-');
    expect(ownerRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    await publishWorkspaceMemoryProviderOverride({
      dataOwnerId: 'owner-fixture',
      ownerRoot,
      canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
      provider: 'xdt',
    });
    const repoRoot = await tempDir('cindy-hbus-prod-uuid-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    const target = await resolveHostFacadeWriteTarget({
      prepared: prepared(PRODUCTION_WRITE_WORKSPACE),
      owner: { dataOwnerId: 'owner-fixture', ownerRoot },
      repoRoot,
      dataRoot,
    });
    expect(target).toEqual({
      repoRoot,
      dataRoot,
      workspace: PRODUCTION_WRITE_WORKSPACE,
    });
    expect(target?.repoRoot.replaceAll('\\', '/')).not.toMatch(/AppData\/Roaming\/Cindy/i);
    expect(target?.repoRoot.replaceAll('\\', '/')).not.toBe(resolveXdtMemoryRoot().replaceAll('\\', '/'));
  });

  it('returns undefined for sandbox UUID and remote even with committed settings', async () => {
    const ownerRoot = await tempDir('cindy-hbus-sandbox-');
    await publishWorkspaceMemoryProviderOverride({
      dataOwnerId: 'owner-fixture',
      ownerRoot,
      canonicalWorkspaceId: PRODUCTION_WRITE_WORKSPACE,
      provider: 'xdt',
    });
    const repoRoot = await tempDir('cindy-hbus-sandbox-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    expect(await resolveHostFacadeWriteTarget({
      prepared: prepared('5fb84df7-8de0-4f74-a7ff-6c7b0850f317'),
      owner: { dataOwnerId: 'owner-fixture', ownerRoot },
      repoRoot,
      dataRoot,
    })).toBeUndefined();
    expect(await resolveHostFacadeWriteTarget({
      prepared: prepared(PRODUCTION_WRITE_WORKSPACE),
      owner: { dataOwnerId: 'owner-fixture', ownerRoot },
      repoRoot,
      dataRoot,
      remoteHostId: 'ssh-1',
    })).toBeUndefined();
    expect(await resolveHostFacadeWriteTarget({
      prepared: prepared(PRODUCTION_WRITE_WORKSPACE),
      owner: { dataOwnerId: 'owner-fixture', ownerRoot },
      repoRoot,
      dataRoot,
      reviewMode: true,
    })).toBeUndefined();
  });
});
