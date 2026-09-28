/**
 * 前置刀 1c：Host 托管 facade HMAC。不得写 ownerRoot/facade-capability.secret。
 */

import { randomBytes } from 'node:crypto';

import { FACADE_CAPABILITY_HMAC_STORAGE_KEY } from '../../shared/providerSecrets.js';
import type { SecretStorageIo } from '../secrets/providerSecretStore.js';

export class FacadeSecretError extends Error {
  readonly code = 'FACADE_SECRET_UNAVAILABLE';

  constructor(message: string) {
    super(`FACADE_SECRET_UNAVAILABLE: ${message}`);
    this.name = 'FacadeSecretError';
  }
}

function decodeSecret(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length !== 32) {
    throw new FacadeSecretError('stored facade HMAC is not 32 bytes');
  }
  return bytes;
}

export function loadHostFacadeCapabilitySecret(io: SecretStorageIo): Buffer {
  if (!io.isAvailable()) {
    throw new FacadeSecretError('safeStorage encryption is unavailable');
  }
  let raw: string | null;
  try {
    raw = io.read(FACADE_CAPABILITY_HMAC_STORAGE_KEY);
  } catch {
    throw new FacadeSecretError('facade HMAC decrypt failed');
  }
  if (raw) return decodeSecret(raw);

  const generated = randomBytes(32);
  let wrote = false;
  try {
    wrote = io.write(FACADE_CAPABILITY_HMAC_STORAGE_KEY, generated.toString('base64'));
  } catch {
    throw new FacadeSecretError('facade HMAC persist failed');
  }
  if (!wrote) {
    throw new FacadeSecretError('facade HMAC persist failed');
  }
  return generated;
}
