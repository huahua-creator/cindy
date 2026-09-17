/**
 * Host session-frozen xdt Memory binding types (段 1).
 *
 * PreparedMemorySession.binding 本刀只允许 XdtMemoryBindingV1。
 * InternalMemoryBindingV1 / DisabledMemoryBindingV1 只作为 schema 闭包存在，
 * 不是本刀 prepare 成功返回值，也不得为现网 internal 会话签发。
 */

import type { AgentKind } from '../types/common.js';
import type { MemoryRecord, SearchHit, SearchOptions, WriteOptions, WriteResult } from './types.js';
import type { ConsolidateOptions, ConsolidateResult } from './store.js';

export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const HEX64_RE = /^[0-9a-f]{64}$/;

export const ISO_UTC_Z_RE =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;

export type XdtPrepareErrorCode =
  | 'WORKSPACE_IDENTITY_REQUIRED'
  | 'WORKSPACE_IDENTITY_CONFLICT'
  | 'CONFIG_INVALID'
  | 'DUPLICATE_WRITABLE_MEMORY_SOURCE'
  | 'INDEX_SNAPSHOT_MISMATCH'
  | 'NATIVE_MEMORY_PROOF_INVALID'
  | 'MAKER_MEMORY_NOT_READY';

export class XdtPrepareError extends Error {
  readonly code: XdtPrepareErrorCode;

  constructor(code: XdtPrepareErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'XdtPrepareError';
    this.code = code;
  }
}

export interface XdtMemoryBindingV1 {
  schemaVersion: 1;
  ownerScopeFingerprint: string;
  ownerEpoch: string;
  configGeneration: string;
  registryGeneration: string;
  bindingDigest: string;
  enabled: true;
  provider: 'xdt';
  canonicalWorkspaceId: string;
  serverRegistrationId: string;
  serverRegistrationGeneration: string;
  serverRegistrationDigest: string;
}

export interface FrozenIndexSnapshotV1 {
  schemaVersion: 1;
  token: string;
  content: string;
  contentDigest: string;
  byteLength: number;
  recordCount: number;
  counts: {
    excludedNonFacade: number;
    v2Compat: number;
    v3: number;
  };
  limitsDigest: string;
  remoteFreshness: 'unknown';
}

export interface NativeMemoryDisabledProofV1 {
  schemaVersion: 1;
  sessionInstanceId: string;
  preparedMemorySessionId: string;
  ownerScopeFingerprint: string;
  ownerEpoch: string;
  bindingDigest: string;
  disabledAt: string;
  observedState: 'disabled';
  observationDigest: string;
  proofDigest: string;
  agentKind: AgentKind;
  mechanism:
    | 'claude-fresh-session-native-memory-off-v1'
    | 'codex-fresh-process-native-memory-off-v1'
    | 'pi-fresh-session-native-memory-off-v1';
  serverRegistrationGeneration: string;
}

export interface FrozenFacadeRecord {
  filename: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  name: string;
  title: string;
  description: string;
  key: string;
  revision: string;
  body: string;
  updatedAt: string;
}

export interface MemorySessionStore {
  list(): Promise<MemoryRecord[]>;
  read(filename: string): Promise<MemoryRecord>;
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  getIndex(): Promise<string>;
  write(opts: WriteOptions): Promise<WriteResult>;
  delete(filename: string): Promise<void>;
  consolidate(opts: ConsolidateOptions): Promise<ConsolidateResult>;
}

export interface PreparedMemorySession {
  preparedMemorySessionId: string;
  binding: XdtMemoryBindingV1;
  indexSnapshot: FrozenIndexSnapshotV1;
  nativeMemoryProof: NativeMemoryDisabledProofV1;
  sessionStore: MemorySessionStore;
  records: readonly FrozenFacadeRecord[];
}

export function isXdtMemoryBinding(value: unknown): value is XdtMemoryBindingV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    v.enabled === true &&
    v.provider === 'xdt' &&
    typeof v.canonicalWorkspaceId === 'string' &&
    UUID_V4_RE.test(v.canonicalWorkspaceId) &&
    typeof v.serverRegistrationId === 'string' &&
    UUID_V4_RE.test(v.serverRegistrationId) &&
    typeof v.bindingDigest === 'string' &&
    HEX64_RE.test(v.bindingDigest) &&
    typeof v.ownerScopeFingerprint === 'string' &&
    HEX64_RE.test(v.ownerScopeFingerprint) &&
    typeof v.ownerEpoch === 'string' &&
    v.ownerEpoch.length > 0 &&
    typeof v.configGeneration === 'string' &&
    v.configGeneration.length > 0 &&
    typeof v.registryGeneration === 'string' &&
    v.registryGeneration.length > 0 &&
    typeof v.serverRegistrationGeneration === 'string' &&
    v.serverRegistrationGeneration.length > 0 &&
    typeof v.serverRegistrationDigest === 'string' &&
    HEX64_RE.test(v.serverRegistrationDigest)
  );
}

export function assertCanonicalWorkspaceUuid(workspace: unknown): string {
  const value = String(workspace ?? '');
  if (!UUID_V4_RE.test(value)) {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'canonical workspace UUID is required before xdt data I/O',
    );
  }
  return value;
}
