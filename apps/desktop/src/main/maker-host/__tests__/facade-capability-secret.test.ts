/**
 * 前置刀 1c：Host HMAC 走 safeStorage。不可用时不得 mint，不得写明文 secret 文件。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FACADE_CAPABILITY_HMAC_STORAGE_KEY } from '../../../shared/providerSecrets.js';
import { FACADE_CAPABILITY_SECRET_FILE } from '../facade-capability.js';
import {
  FacadeSecretError,
  loadHostFacadeCapabilitySecret,
} from '../facade-capability-secret.js';
import type { SecretStorageIo } from '../../secrets/providerSecretStore.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('host facade capability secret', () => {
  it('fails closed when encryption is unavailable and writes no plaintext file', async () => {
    const ownerRoot = await mkdtemp(path.join(tmpdir(), 'cindy-facade-1c-secret-'));
    temps.push(ownerRoot);
    const io: SecretStorageIo = {
      isAvailable: () => false,
      read: () => {
        throw new Error('must not read');
      },
      write: () => {
        throw new Error('must not write');
      },
      remove: () => ({ success: true }),
      list: () => [],
    };
    expect(() => loadHostFacadeCapabilitySecret(io)).toThrow(FacadeSecretError);
    await expect(stat(path.join(ownerRoot, FACADE_CAPABILITY_SECRET_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('persists a 32-byte secret through Host storage and never logs the bytes', () => {
    const store = new Map<string, string>();
    const io: SecretStorageIo = {
      isAvailable: () => true,
      read: (key) => store.get(key) ?? null,
      write: (key, value) => {
        store.set(key, value);
        return true;
      },
      remove: (key) => {
        store.delete(key);
        return { success: true };
      },
      list: () => [...store.keys()],
    };
    const first = loadHostFacadeCapabilitySecret(io);
    expect(first).toHaveLength(32);
    expect(store.has(FACADE_CAPABILITY_HMAC_STORAGE_KEY)).toBe(true);
    const second = loadHostFacadeCapabilitySecret(io);
    expect(Buffer.compare(first, second)).toBe(0);
    const json = JSON.stringify({
      key: FACADE_CAPABILITY_HMAC_STORAGE_KEY,
      stored: store.get(FACADE_CAPABILITY_HMAC_STORAGE_KEY),
    });
    expect(json).not.toContain(first.toString('utf8'));
    expect(store.get(FACADE_CAPABILITY_HMAC_STORAGE_KEY)).not.toEqual(first.toString('utf8'));
  });

  it('fails closed when decrypt throws', () => {
    const io: SecretStorageIo = {
      isAvailable: () => true,
      read: () => {
        throw new Error('decrypt failed');
      },
      write: () => true,
      remove: () => ({ success: true }),
      list: () => [],
    };
    expect(() => loadHostFacadeCapabilitySecret(io)).toThrow(/FACADE_SECRET_UNAVAILABLE/);
  });
});
