/**
 * 前置刀 1b：Host 侧 mint / verify FacadeInitialInvocationCapabilityV1。
 * 能力只走进程内通道；密钥不得写入 journal / ledger / 日志。
 * 生产对象不得用 CAP-FIXTURE-MAC 当放行门。
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { freezeUtcZ, HEX64_RE, UUID_V4_RE } from '@cindy/maker-core';

import { projectControlObject } from './facade-canonical.js';

export const FACADE_CAPABILITY_SECRET_FILE = 'facade-capability.secret';
export const FACADE_ISSUER_GENERATION = 'cindy-host-facade-v1';
const CAPABILITY_MAC_EXCLUDED = Object.freeze(['capabilityMac']);
const TTL_MS = 60 * 60 * 1000;

export type FacadeInnerToolName = 'memory_write' | 'memory_delete' | 'memory_consolidate';

export interface FacadeInitialInvocationCapabilityV1 {
  schemaVersion: 1;
  capabilityKind: 'initial';
  issuer: 'cindy-host';
  issuerGeneration: string;
  invocationId: string;
  sessionInstanceId: string;
  preparedMemorySessionId: string;
  toolEntry: 'call_tool';
  innerToolName: FacadeInnerToolName;
  normalizedArgsDigest: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  capabilityMac: string;
}

export interface MintFacadeCapabilityInput {
  innerToolName: FacadeInnerToolName;
  normalizedArgsDigest: string;
  sessionInstanceId: string;
  preparedMemorySessionId: string;
  invocationId?: string;
  issuerGeneration?: string;
  issuedAt?: string;
  expiresAt?: string;
  nonce?: string;
}

export function facadeCapabilityMac(
  object: Omit<FacadeInitialInvocationCapabilityV1, 'capabilityMac'> | FacadeInitialInvocationCapabilityV1,
  secret: string | Buffer,
): string {
  const { capabilityMac: _ignored, ...unsigned } = object as FacadeInitialInvocationCapabilityV1;
  const projected = projectControlObject(unsigned, [...CAPABILITY_MAC_EXCLUDED]);
  return createHmac('sha256', secret).update(projected, 'utf8').digest('hex');
}

export function mintFacadeInitialCapability(
  input: MintFacadeCapabilityInput,
  secret: string | Buffer,
): FacadeInitialInvocationCapabilityV1 {
  if (!HEX64_RE.test(input.normalizedArgsDigest)) {
    throw new Error('normalizedArgsDigest must be sha256 hex');
  }
  if (!UUID_V4_RE.test(input.sessionInstanceId) || !UUID_V4_RE.test(input.preparedMemorySessionId)) {
    throw new Error('sessionInstanceId and preparedMemorySessionId must be UUID v4');
  }
  const issuedAt = freezeUtcZ(input.issuedAt ?? new Date().toISOString());
  const expiresAt = freezeUtcZ(
    input.expiresAt ?? new Date(Date.parse(issuedAt) + TTL_MS).toISOString(),
  );
  const unsigned: Omit<FacadeInitialInvocationCapabilityV1, 'capabilityMac'> = {
    schemaVersion: 1,
    capabilityKind: 'initial',
    issuer: 'cindy-host',
    issuerGeneration: input.issuerGeneration ?? FACADE_ISSUER_GENERATION,
    invocationId: input.invocationId ?? randomUUID(),
    sessionInstanceId: input.sessionInstanceId,
    preparedMemorySessionId: input.preparedMemorySessionId,
    toolEntry: 'call_tool',
    innerToolName: input.innerToolName,
    normalizedArgsDigest: input.normalizedArgsDigest,
    issuedAt,
    expiresAt,
    nonce: input.nonce ?? randomUUID(),
  };
  return {
    ...unsigned,
    capabilityMac: facadeCapabilityMac(unsigned, secret),
  };
}

export function verifyFacadeInitialCapability(
  capability: FacadeInitialInvocationCapabilityV1,
  secret: string | Buffer,
): boolean {
  if (
    capability.schemaVersion !== 1
    || capability.capabilityKind !== 'initial'
    || capability.issuer !== 'cindy-host'
    || capability.toolEntry !== 'call_tool'
    || !HEX64_RE.test(capability.capabilityMac)
  ) {
    return false;
  }
  return capability.capabilityMac === facadeCapabilityMac(capability, secret);
}

export function facadeCapabilitySecretPath(ownerRoot: string): string {
  return path.join(ownerRoot, FACADE_CAPABILITY_SECRET_FILE);
}

/**
 * 测试注入密钥；生产 Desktop 走 ownerRoot 旁路 generate-once 文件（明文债，不进 journal）。
 * 不得把密钥写进 ledger / journal JSON，不得打日志。
 */
export async function loadOrCreateFacadeCapabilitySecret(ownerRoot: string): Promise<Buffer> {
  const filePath = facadeCapabilitySecretPath(ownerRoot);
  await fsp.mkdir(ownerRoot, { recursive: true });
  try {
    const handle = await fsp.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const bytes = await fsp.readFile(filePath);
  if (bytes.length !== 32) {
    throw new Error('facade capability secret must be 32 bytes');
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error('facade capability secret must not be a symlink');
  }
  return bytes;
}
