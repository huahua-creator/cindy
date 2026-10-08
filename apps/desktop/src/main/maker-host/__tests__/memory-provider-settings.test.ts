/**
 * 刀 3：独立 MemoryProviderSettingsV1 + settings_only 事务。
 * 夹具只用 temp ownerRoot。禁止生产 UUID / 生产 userData / 切 defaultProvider。
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLocalAlias,
  loadMemoryProviderSettings,
  lookupLocalAlias,
  publishMemoryProviderSettings,
  readMemoryProviderSettings,
  readRegistry,
  __testOnly,
  type MemoryProviderSettingsV1,
} from '../workspace-identity-registry';
import {
  getPreparedMemorySession,
  rememberPreparedMemorySession,
  resetPreparedMemorySessionsForTest,
} from '../prepared-memory-sessions';
import type { PreparedMemorySession } from '@cindy/maker-core';

const OWNER = 'owner-fixture-settings-only';
const BANNED = [
  'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
  '5fb84df7-8de0-4f74-a7ff-6c7b0850f317',
];
const HEX_A = 'a'.repeat(64);
const HEX_C = 'c'.repeat(64);
const TXN_ID = '33333333-3333-4333-8333-333333333333';
const temps: string[] = [];

afterEach(async () => {
  __testOnly.setSettingsRecoverHookForTest(undefined);
  resetPreparedMemorySessionsForTest();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function scope() {
  const ownerRoot = await tempDir('cindy-xdt-settings-owner-');
  const absDir = await tempDir('cindy-xdt-settings-ws-');
  expect(ownerRoot).not.toMatch(/AppData[\\/]Roaming[\\/]Cindy/i);
  expect(BANNED.some((id) => ownerRoot.includes(id))).toBe(false);
  return { dataOwnerId: OWNER, ownerRoot, absDir };
}

function internalSettings(generation: string): MemoryProviderSettingsV1 {
  return {
    schemaVersion: 1,
    defaultProvider: 'internal',
    workspaceOverrides: {},
    configGeneration: generation,
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function digestUtf8(utf8: string): string {
  const body = utf8.endsWith('\n') ? utf8.slice(0, -1) : utf8;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

async function writeTxn(ownerRoot: string, txn: unknown): Promise<void> {
  await writeFile(path.join(ownerRoot, 'workspace-registry-transaction-v1.json'), serialize(txn), 'utf8');
}

async function readTxn(ownerRoot: string): Promise<{ state: string; operationKind: string }> {
  return JSON.parse(await readFile(path.join(ownerRoot, 'workspace-registry-transaction-v1.json'), 'utf8')) as {
    state: string;
    operationKind: string;
  };
}

function stubPrepared(): PreparedMemorySession {
  return {
    preparedMemorySessionId: '44444444-4444-4444-8444-444444444444',
    binding: {
      schemaVersion: 1,
      ownerScopeFingerprint: HEX_A,
      ownerEpoch: 'epoch-1',
      configGeneration: 'cfg-1',
      registryGeneration: 'reg-1',
      bindingDigest: HEX_A,
      enabled: true,
      provider: 'xdt',
      canonicalWorkspaceId: '11111111-1111-4111-8111-111111111111',
      serverRegistrationId: '22222222-2222-4222-8222-222222222222',
      serverRegistrationGeneration: 'gen-1',
      serverRegistrationDigest: HEX_C,
    },
    indexSnapshot: {
      schemaVersion: 1,
      token: 'tok',
      content: '',
      contentDigest: HEX_A,
      byteLength: 0,
      recordCount: 0,
      counts: { excludedNonFacade: 0, v2Compat: 0, v3: 0 },
      limitsDigest: HEX_A,
      remoteFreshness: 'unknown',
    },
    nativeMemoryProof: {
      schemaVersion: 1,
      sessionInstanceId: '33333333-3333-4333-8333-333333333333',
      preparedMemorySessionId: '44444444-4444-4444-8444-444444444444',
      ownerScopeFingerprint: HEX_A,
      ownerEpoch: 'epoch-1',
      bindingDigest: HEX_A,
      disabledAt: '2026-09-16T00:00:00.000Z',
      observedState: 'disabled',
      observationDigest: HEX_A,
      proofDigest: HEX_A,
      agentKind: 'claude-code',
      mechanism: 'claude-fresh-session-native-memory-off-v1',
      serverRegistrationGeneration: 'gen-1',
    },
    sessionStore: {} as PreparedMemorySession['sessionStore'],
    records: [],
  };
}

describe('memory provider settings independent file', () => {
  it('treats a missing file as internal and does not create it', async () => {
    const { dataOwnerId, ownerRoot } = await scope();
    const read = await loadMemoryProviderSettings({ dataOwnerId, ownerRoot });
    expect(read.status).toBe('missing');
    expect(read.effectiveProvider).toBe('internal');
    expect(existsSync(__testOnly.settingsPath({ dataOwnerId, ownerRoot }))).toBe(false);
    const listing = await readdir(ownerRoot);
    expect(listing).not.toContain(__testOnly.SETTINGS_FILE);
    expect(listing).not.toContain('workspace-identity-registry-v1.json.lock');
  });

  it('keeps digest namespaces distinct', () => {
    expect(__testOnly.missingSettingsDigest()).toBe(createHash('sha256').update('', 'utf8').digest('hex'));
    expect(__testOnly.missingSettingsDigest()).not.toBe(__testOnly.settingsSentinel().digest);
    expect(__testOnly.missingSettingsDigest()).not.toBe(__testOnly.emptyRegistryDigest());
    expect(__testOnly.settingsSentinel().digest).toBe('0'.repeat(64));
  });

  it('returns CONFIG_INVALID for corrupt JSON and keeps the original file', async () => {
    const { dataOwnerId, ownerRoot } = await scope();
    const file = __testOnly.settingsPath({ dataOwnerId, ownerRoot });
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(file, '{not-json', 'utf8');
    const raw = readMemoryProviderSettings({ dataOwnerId, ownerRoot });
    expect(raw.status).toBe('invalid');
    await expect(loadMemoryProviderSettings({ dataOwnerId, ownerRoot })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(file, 'utf8')).toBe('{not-json');
  });

  it('returns CONFIG_INVALID for unknown fields and keeps the original file', async () => {
    const { dataOwnerId, ownerRoot } = await scope();
    const file = __testOnly.settingsPath({ dataOwnerId, ownerRoot });
    const extra = {
      ...internalSettings('cfg-unknown'),
      extraKey: true,
    };
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(file, serialize(extra), 'utf8');
    await expect(loadMemoryProviderSettings({ dataOwnerId, ownerRoot })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(file, 'utf8')).toBe(serialize(extra));
  });

  it('returns CONFIG_INVALID for defaultProvider=xdt without registration', async () => {
    const { dataOwnerId, ownerRoot } = await scope();
    const file = __testOnly.settingsPath({ dataOwnerId, ownerRoot });
    const bad = {
      schemaVersion: 1,
      defaultProvider: 'xdt',
      workspaceOverrides: {},
      configGeneration: 'cfg-xdt-missing',
    };
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(file, serialize(bad), 'utf8');
    await expect(loadMemoryProviderSettings({ dataOwnerId, ownerRoot })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(file, 'utf8')).toBe(serialize(bad));
  });

  it('returns CONFIG_INVALID for an unreadable settings file and keeps it', async () => {
    if (process.platform === 'win32') return;
    const { dataOwnerId, ownerRoot } = await scope();
    const file = __testOnly.settingsPath({ dataOwnerId, ownerRoot });
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(file, serialize(internalSettings('cfg-unreadable')), 'utf8');
    chmodSync(file, 0);
    try {
      await expect(loadMemoryProviderSettings({ dataOwnerId, ownerRoot })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
      expect(existsSync(file)).toBe(true);
    } finally {
      chmodSync(file, 0o644);
    }
  });
});

describe('settings_only recover machine', () => {
  async function seedPublished(ownerRoot: string, dataOwnerId: string, absDir: string) {
    const alias = await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const settings = internalSettings('cfg-after');
    const settingsUtf8 = serialize(settings);
    await writeFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), settingsUtf8, 'utf8');
    const registryUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    const registryDigest = digestUtf8(registryUtf8);
    const parsed = JSON.parse(registryUtf8.endsWith('\n') ? registryUtf8.slice(0, -1) : registryUtf8) as {
      registryGeneration: string;
    };
    return {
      alias,
      settings,
      settingsUtf8,
      registryDigest,
      registryGeneration: parsed.registryGeneration,
      settingsDigest: digestUtf8(settingsUtf8),
    };
  }

  function settingsOnlyTxn(input: {
    state: 'prepared' | 'settings_published' | 'committed';
    registryGeneration: string;
    registryDigest: string;
    beforeDigest: string;
    afterDigest: string;
    expectedConfig?: string;
    intendedConfig?: string;
  }) {
    return {
      schemaVersion: 1,
      transactionId: TXN_ID,
      operationKind: 'settings_only' as const,
      expectedRegistryGeneration: input.registryGeneration,
      expectedProviderConfigGeneration: input.expectedConfig ?? 'settings-unpublished',
      intendedRegistryGeneration: input.registryGeneration,
      intendedProviderConfigGeneration: input.intendedConfig ?? 'cfg-after',
      registryDigestBefore: input.registryDigest,
      providerSettingsDigestBefore: input.beforeDigest,
      registryDigestAfter: input.registryDigest,
      providerSettingsDigestAfter: input.afterDigest,
      state: input.state,
    };
  }

  it('settings_published + after fills committed', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const seeded = await seedPublished(ownerRoot, dataOwnerId, absDir);
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'settings_published',
      registryGeneration: seeded.registryGeneration,
      registryDigest: seeded.registryDigest,
      beforeDigest: __testOnly.missingSettingsDigest(),
      afterDigest: seeded.settingsDigest,
    }));
    const loaded = await loadMemoryProviderSettings({ dataOwnerId, ownerRoot });
    expect(loaded.status).toBe('readable');
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'committed', operationKind: 'settings_only' });
    await lookupLocalAlias({ dataOwnerId, ownerRoot, absDir });
  });

  it('settings_published + before stays CONFIG_INVALID and keeps the original file', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const seeded = await seedPublished(ownerRoot, dataOwnerId, absDir);
    const beforeUtf8 = serialize(internalSettings('cfg-before'));
    await writeFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), beforeUtf8, 'utf8');
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'settings_published',
      registryGeneration: seeded.registryGeneration,
      registryDigest: seeded.registryDigest,
      beforeDigest: digestUtf8(beforeUtf8),
      afterDigest: seeded.settingsDigest,
    }));
    await expect(lookupLocalAlias({ dataOwnerId, ownerRoot, absDir })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), 'utf8')).toBe(beforeUtf8);
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'settings_published' });
  });

  it('settings_published + neither stays CONFIG_INVALID and keeps the original file', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const seeded = await seedPublished(ownerRoot, dataOwnerId, absDir);
    const neitherUtf8 = serialize(internalSettings('cfg-neither'));
    await writeFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), neitherUtf8, 'utf8');
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'settings_published',
      registryGeneration: seeded.registryGeneration,
      registryDigest: seeded.registryDigest,
      beforeDigest: __testOnly.missingSettingsDigest(),
      afterDigest: seeded.settingsDigest,
    }));
    await expect(lookupLocalAlias({ dataOwnerId, ownerRoot, absDir })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), 'utf8')).toBe(neitherUtf8);
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'settings_published' });
  });

  it('prepared + after fills settings_published then committed with dual digest reread', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const seeded = await seedPublished(ownerRoot, dataOwnerId, absDir);
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'prepared',
      registryGeneration: seeded.registryGeneration,
      registryDigest: seeded.registryDigest,
      beforeDigest: __testOnly.missingSettingsDigest(),
      afterDigest: seeded.settingsDigest,
    }));
    const seen: string[] = [];
    __testOnly.setSettingsRecoverHookForTest(async () => {
      seen.push('settings_published');
      const live = await readTxn(ownerRoot);
      expect(live.state).toBe('settings_published');
      const registryUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
      expect(digestUtf8(registryUtf8)).toBe(seeded.registryDigest);
      const settingsUtf8 = await readFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), 'utf8');
      expect(digestUtf8(settingsUtf8)).toBe(seeded.settingsDigest);
    });
    await lookupLocalAlias({ dataOwnerId, ownerRoot, absDir });
    expect(seen).toEqual(['settings_published']);
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'committed', operationKind: 'settings_only' });
  });

  it('mid consecutive-fill registry digest change is CONFIG_INVALID and does not mark committed', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const seeded = await seedPublished(ownerRoot, dataOwnerId, absDir);
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'prepared',
      registryGeneration: seeded.registryGeneration,
      registryDigest: seeded.registryDigest,
      beforeDigest: __testOnly.missingSettingsDigest(),
      afterDigest: seeded.settingsDigest,
    }));
    __testOnly.setSettingsRecoverHookForTest(async () => {
      const file = path.join(ownerRoot, 'workspace-identity-registry-v1.json');
      const current = JSON.parse(await readFile(file, 'utf8')) as {
        schemaVersion: 1;
        registryGeneration: string;
        workspaces: Record<string, unknown>;
        aliases: Record<string, unknown>;
      };
      current.registryGeneration = `${current.registryGeneration}-drift`;
      await writeFile(file, serialize(current), 'utf8');
    });
    await expect(lookupLocalAlias({ dataOwnerId, ownerRoot, absDir })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'settings_published' });
    expect(await readFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), 'utf8')).toBe(seeded.settingsUtf8);
  });

  it('keeps settings_published and the txn file when step 2 fails', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const seeded = await seedPublished(ownerRoot, dataOwnerId, absDir);
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'prepared',
      registryGeneration: seeded.registryGeneration,
      registryDigest: seeded.registryDigest,
      beforeDigest: __testOnly.missingSettingsDigest(),
      afterDigest: seeded.settingsDigest,
    }));
    __testOnly.setSettingsRecoverHookForTest(() => {
      throw new Error('forced step-2 failure');
    });
    await expect(lookupLocalAlias({ dataOwnerId, ownerRoot, absDir })).rejects.toThrow(/forced step-2 failure/);
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'settings_published', operationKind: 'settings_only' });
    expect(existsSync(path.join(ownerRoot, 'workspace-registry-transaction-v1.json'))).toBe(true);
  });

  it('prepared + empty file with missing digest is CONFIG_INVALID and keeps the txn', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const registryUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    const parsed = JSON.parse(registryUtf8.endsWith('\n') ? registryUtf8.slice(0, -1) : registryUtf8) as {
      registryGeneration: string;
    };
    await writeFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), '', 'utf8');
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'prepared',
      registryGeneration: parsed.registryGeneration,
      registryDigest: digestUtf8(registryUtf8),
      beforeDigest: __testOnly.missingSettingsDigest(),
      afterDigest: HEX_A,
    }));
    await expect(lookupLocalAlias({ dataOwnerId, ownerRoot, absDir })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'prepared' });
    expect(await readFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), 'utf8')).toBe('');
  });

  it('prepared + corrupt JSON with matching before digest is CONFIG_INVALID and keeps the txn', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const registryUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    const parsed = JSON.parse(registryUtf8.endsWith('\n') ? registryUtf8.slice(0, -1) : registryUtf8) as {
      registryGeneration: string;
    };
    const corrupt = '{not-json';
    await writeFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), corrupt, 'utf8');
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'prepared',
      registryGeneration: parsed.registryGeneration,
      registryDigest: digestUtf8(registryUtf8),
      beforeDigest: digestUtf8(corrupt),
      afterDigest: HEX_A,
    }));
    await expect(lookupLocalAlias({ dataOwnerId, ownerRoot, absDir })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readTxn(ownerRoot)).toMatchObject({ state: 'prepared' });
    expect(await readFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), 'utf8')).toBe(corrupt);
  });

  it('prepared + before deletes the txn without writing settings', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const registryUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    const parsed = JSON.parse(registryUtf8.endsWith('\n') ? registryUtf8.slice(0, -1) : registryUtf8) as {
      registryGeneration: string;
    };
    await writeTxn(ownerRoot, settingsOnlyTxn({
      state: 'prepared',
      registryGeneration: parsed.registryGeneration,
      registryDigest: digestUtf8(registryUtf8),
      beforeDigest: __testOnly.missingSettingsDigest(),
      afterDigest: HEX_A,
    }));
    await lookupLocalAlias({ dataOwnerId, ownerRoot, absDir });
    await expect(readFile(path.join(ownerRoot, 'workspace-registry-transaction-v1.json'), 'utf8')).rejects.toThrow();
    expect(existsSync(__testOnly.settingsPath({ dataOwnerId, ownerRoot }))).toBe(false);
  });
});

describe('settings_only publish', () => {
  it('does not change registry generation or digest', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const beforeUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    await publishMemoryProviderSettings({
      dataOwnerId,
      ownerRoot,
      settings: internalSettings('cfg-publish-1'),
    });
    const afterUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    expect(afterUtf8).toBe(beforeUtf8);
    const loaded = await loadMemoryProviderSettings({ dataOwnerId, ownerRoot });
    expect(loaded.effectiveProvider).toBe('internal');
    expect(loaded.settings?.configGeneration).toBe('cfg-publish-1');
  });

  it('does not revoke an already-prepared readonly extra session', async () => {
    const { dataOwnerId, ownerRoot } = await scope();
    const prepared = stubPrepared();
    rememberPreparedMemorySession(prepared);
    await publishMemoryProviderSettings({
      dataOwnerId,
      ownerRoot,
      settings: internalSettings('cfg-keep-prepared'),
    });
    expect(getPreparedMemorySession(prepared.preparedMemorySessionId)?.preparedMemorySessionId)
      .toBe(prepared.preparedMemorySessionId);
  });

  it('does not change boolean memory-settings.json bytes', async () => {
    const { dataOwnerId, ownerRoot } = await scope();
    const booleanPath = __testOnly.booleanMemorySettingsPath({ dataOwnerId, ownerRoot });
    const original = '{"maker":true,"claudeCode":true,"codex":true,"pi":true}\n';
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(booleanPath, original, 'utf8');
    await publishMemoryProviderSettings({
      dataOwnerId,
      ownerRoot,
      settings: internalSettings('cfg-boolean-untouched'),
    });
    expect(await readFile(booleanPath, 'utf8')).toBe(original);
  });

  it('rejects registry_and_settings without rewriting settings', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    const seededAlias = await createLocalAlias({ dataOwnerId, ownerRoot, absDir, confirmed: true });
    const settingsUtf8 = serialize(internalSettings('cfg-both'));
    await writeFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), settingsUtf8, 'utf8');
    const registryUtf8 = await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8');
    await writeTxn(ownerRoot, {
      schemaVersion: 1,
      transactionId: TXN_ID,
      operationKind: 'registry_and_settings',
      expectedRegistryGeneration: 'reg-empty',
      expectedProviderConfigGeneration: 'settings-unpublished',
      intendedRegistryGeneration: 'reg-1',
      intendedProviderConfigGeneration: 'cfg-both',
      registryDigestBefore: HEX_A,
      providerSettingsDigestBefore: __testOnly.missingSettingsDigest(),
      registryDigestAfter: digestUtf8(registryUtf8),
      providerSettingsDigestAfter: digestUtf8(settingsUtf8),
      state: 'prepared',
    });
    await expect(lookupLocalAlias({ dataOwnerId, ownerRoot, absDir })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(__testOnly.settingsPath({ dataOwnerId, ownerRoot }), 'utf8')).toBe(settingsUtf8);
    expect(seededAlias.canonicalWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('createLocalAlias still uses SETTINGS_UNCHANGED_SENTINEL after a real settings file exists', async () => {
    const { dataOwnerId, ownerRoot, absDir } = await scope();
    await publishMemoryProviderSettings({
      dataOwnerId,
      ownerRoot,
      settings: internalSettings('cfg-before-alias'),
    });
    const other = await tempDir('cindy-xdt-settings-ws2-');
    await createLocalAlias({ dataOwnerId, ownerRoot, absDir: other, confirmed: true });
    const txn = JSON.parse(
      await readFile(path.join(ownerRoot, 'workspace-registry-transaction-v1.json'), 'utf8'),
    ) as {
      operationKind: string;
      expectedProviderConfigGeneration: string;
      providerSettingsDigestBefore: string;
      providerSettingsDigestAfter: string;
    };
    expect(txn.operationKind).toBe('registry_only');
    expect(txn.expectedProviderConfigGeneration).toBe('settings-side-unpublished-v1');
    expect(txn.providerSettingsDigestBefore).toBe('0'.repeat(64));
    expect(txn.providerSettingsDigestAfter).toBe('0'.repeat(64));
    expect(readRegistry({ dataOwnerId, ownerRoot }).status).toBe('readable');
  });
});

describe('settings_only source hygiene', () => {
  it('does not import OverrideSettingsFile, memory-settings-store, or ownerScopedUserDataPath', async () => {
    const src = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace-identity-registry.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"].*override-settings-file/);
    expect(src).not.toMatch(/from ['"].*memory-settings-store/);
    expect(src).not.toMatch(/from ['"].*appSessionState/);
    expect(src).not.toMatch(/forgetPreparedMemorySession/);
    expect(src).not.toMatch(/defaultProvider:\s*'xdt'/);
  });
});
