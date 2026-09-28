/**
 * NativeMemoryDisabledProofV1 for xdt prepare only.
 * setMemory(false) 成功 ≠ proof。unsupported / next-session 且未回读
 * observedState=disabled 都不是 proof。internal 继续现有 enable()，不要求 proof。
 */

import { createHash } from 'node:crypto';

import type { AgentKind } from '../types/common.js';
import type { MemorySetResult, MemoryStatus } from '../types/memory.js';
import {
  HEX64_RE,
  ISO_UTC_Z_RE,
  UUID_V4_RE,
  XdtPrepareError,
  type NativeMemoryDisabledProofV1,
  type XdtMemoryBindingV1,
} from './xdt-binding.js';

const MECHANISM_BY_AGENT: Record<
  AgentKind,
  NativeMemoryDisabledProofV1['mechanism']
> = {
  'claude-code': 'claude-fresh-session-native-memory-off-v1',
  codex: 'codex-fresh-process-native-memory-off-v1',
  pi: 'pi-fresh-session-native-memory-off-v1',
};

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function nativeProofMechanism(agentKind: AgentKind): NativeMemoryDisabledProofV1['mechanism'] {
  return MECHANISM_BY_AGENT[agentKind];
}

/** schema `isoUtc` 只认 `...Z`，禁止 `toISOString()` 在部分运行时产出的 `+00:00`。 */
export function freezeUtcZ(value: string): string {
  if (ISO_UTC_Z_RE.test(value)) return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'disabledAt must be UTC Z');
  }
  const frozen = new Date(parsed).toISOString();
  if (!ISO_UTC_Z_RE.test(frozen)) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'disabledAt must be UTC Z');
  }
  return frozen;
}

export function buildNativeMemoryDisabledProof(input: {
  sessionInstanceId: string;
  preparedMemorySessionId: string;
  binding: XdtMemoryBindingV1;
  agentKind: AgentKind;
  disabledAt?: string;
}): NativeMemoryDisabledProofV1 {
  const disabledAt = freezeUtcZ(input.disabledAt ?? new Date().toISOString());
  const observationMaterial = [
    input.sessionInstanceId,
    input.preparedMemorySessionId,
    input.agentKind,
    'disabled',
    nativeProofMechanism(input.agentKind),
    input.binding.serverRegistrationGeneration,
  ].join(':');
  const observationDigest = sha256Hex(observationMaterial);
  const proofDigest = sha256Hex(
    `${input.binding.bindingDigest}:${observationDigest}:${disabledAt}`,
  );
  return {
    schemaVersion: 1,
    sessionInstanceId: input.sessionInstanceId,
    preparedMemorySessionId: input.preparedMemorySessionId,
    ownerScopeFingerprint: input.binding.ownerScopeFingerprint,
    ownerEpoch: input.binding.ownerEpoch,
    bindingDigest: input.binding.bindingDigest,
    disabledAt,
    observedState: 'disabled',
    observationDigest,
    proofDigest,
    agentKind: input.agentKind,
    mechanism: nativeProofMechanism(input.agentKind),
    serverRegistrationGeneration: input.binding.serverRegistrationGeneration,
  };
}

export function assertNativeMemoryDisabledProof(
  proof: NativeMemoryDisabledProofV1,
  expected: {
    sessionInstanceId: string;
    preparedMemorySessionId: string;
    agentKind: AgentKind;
    binding: XdtMemoryBindingV1;
  },
): NativeMemoryDisabledProofV1 {
  if (proof.observedState !== 'disabled') {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'observedState must be disabled');
  }
  if (proof.sessionInstanceId !== expected.sessionInstanceId) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'sessionInstanceId mismatch');
  }
  if (proof.preparedMemorySessionId !== expected.preparedMemorySessionId) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'preparedMemorySessionId mismatch');
  }
  if (proof.agentKind !== expected.agentKind) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'agentKind mismatch');
  }
  if (proof.mechanism !== nativeProofMechanism(expected.agentKind)) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'mechanism mismatch');
  }
  if (proof.bindingDigest !== expected.binding.bindingDigest) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'bindingDigest mismatch');
  }
  if (proof.serverRegistrationGeneration !== expected.binding.serverRegistrationGeneration) {
    throw new XdtPrepareError(
      'NATIVE_MEMORY_PROOF_INVALID',
      'serverRegistrationGeneration mismatch',
    );
  }
  if (!UUID_V4_RE.test(proof.sessionInstanceId) || !UUID_V4_RE.test(proof.preparedMemorySessionId)) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'proof ids must be UUID v4');
  }
  if (!HEX64_RE.test(proof.observationDigest) || !HEX64_RE.test(proof.proofDigest)) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'proof digests must be sha256 hex');
  }
  if (!ISO_UTC_Z_RE.test(proof.disabledAt)) {
    throw new XdtPrepareError('NATIVE_MEMORY_PROOF_INVALID', 'disabledAt must be UTC Z');
  }
  return proof;
}

export function nativeSetMemoryIsProof(
  result: MemorySetResult | { effective: MemorySetResult['effective'] | 'unsupported' },
  status?: MemoryStatus,
): boolean {
  if (result.effective === 'unsupported') return false;
  if (result.effective === 'next-session' && status?.enabled !== false) return false;
  return status?.enabled === false;
}
