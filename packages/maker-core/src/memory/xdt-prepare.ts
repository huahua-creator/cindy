/**
 * Host-only prepareMemorySession — 只服务 xdt fixture。
 * 必须对独立 temp git/data 树调用 xdt-memory memory_index（mutation disabled）。
 * 禁止调用方传入 FrozenIndexSnapshotV1.content；records 只能来自同一 snapshot 约束下的 facade 投影。
 */

import { randomUUID } from 'node:crypto';

import type { AgentKind } from '../types/common.js';
import type { MemorySetResult, MemoryStatus } from '../types/memory.js';
import type { MakerMemoryManager } from './manager.js';
import {
  assertCanonicalWorkspaceUuid,
  isXdtMemoryBinding,
  UUID_V4_RE,
  XdtPrepareError,
  type FrozenFacadeRecord,
  type FrozenIndexSnapshotV1,
  type PreparedMemorySession,
  type XdtMemoryBindingV1,
} from './xdt-binding.js';
import { createXdtFrozenSessionStore } from './xdt-frozen-store.js';
import {
  assertRecordsMatchSnapshot,
  projectFacadeRecordsFromIndex,
  readFrozenIndexFromXdt,
  type MemoryIndexClient,
  type XdtIndexSource,
} from './xdt-index.js';
import {
  assertNativeMemoryDisabledProof,
  buildNativeMemoryDisabledProof,
  nativeSetMemoryIsProof,
} from './xdt-native-proof.js';
import {
  assertFrozenIndexSchema,
  assertNativeProofSchema,
  assertXdtBindingSchema,
} from './xdt-schema.js';
import { assertFrozenIndexSnapshot } from './xdt-snapshot-token.js';
import { assertNoDuplicateWritableMemorySource } from './xdt-writable-sources.js';

export interface PrepareMemorySessionInput {
  agentKind: AgentKind;
  sessionInstanceId: string;
  binding: XdtMemoryBindingV1;
  isolatedStanzaPresent: boolean;
  nativeSetResult: MemorySetResult;
  nativeObservedStatus: MemoryStatus;
  preparedMemorySessionId?: string;
  /** fixture UUID + 独立 temp git/data 树。成功路径只对它调 MemoryStore.index()。 */
  indexSource?: XdtIndexSource;
  /**
   * 仅负向测试：手写 client 证明旁路必须红。
   * 生产 prepare 禁止此字段；即使传入 createXdtMemoryIndexClient() 也必须同时给 indexSource。
   */
  indexClient?: MemoryIndexClient;
  xdtReadOnlyScope: string;
  makerMemory: Pick<MakerMemoryManager, 'markXdtReadOnlyScope'>;
  xdtMemoryRoot?: string;
}

export async function prepareMemorySession(
  input: PrepareMemorySessionInput,
): Promise<PreparedMemorySession> {
  const raw = input as PrepareMemorySessionInput & {
    snapshot?: unknown;
    records?: unknown;
  };
  if (raw.snapshot !== undefined || raw.records !== undefined) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'prepareMemorySession must call xdt-memory memory_index; caller-supplied snapshot.content is forbidden',
    );
  }
  if (input.indexClient && !input.indexSource) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'prepareMemorySession production path forbids indexClient; only indexSource → MemoryStore.index() is allowed',
    );
  }
  if (!UUID_V4_RE.test(input.sessionInstanceId)) {
    throw new XdtPrepareError('CONFIG_INVALID', 'sessionInstanceId must be UUID v4');
  }
  if (!isXdtMemoryBinding(input.binding)) {
    throw new XdtPrepareError('CONFIG_INVALID', 'PreparedMemorySession.binding must be XdtMemoryBindingV1');
  }
  assertXdtBindingSchema(input.binding, input.xdtMemoryRoot);
  assertCanonicalWorkspaceUuid(input.binding.canonicalWorkspaceId);
  assertNoDuplicateWritableMemorySource({
    agentKind: input.agentKind,
    isolatedStanzaPresent: input.isolatedStanzaPresent,
  });
  if (!nativeSetMemoryIsProof(input.nativeSetResult, input.nativeObservedStatus)) {
    throw new XdtPrepareError(
      'NATIVE_MEMORY_PROOF_INVALID',
      'setMemory(false) success is not NativeMemoryDisabledProofV1; observedState must be disabled',
    );
  }

  const snapshot = await loadIndexSnapshot(input);
  assertFrozenIndexSchema(snapshot, input.xdtMemoryRoot);
  const checked = assertFrozenIndexSnapshot(snapshot);
  const records = await loadFacadeRecords(input, checked);
  assertRecordsMatchSnapshot(checked, records);

  const preparedMemorySessionId = input.preparedMemorySessionId ?? randomUUID();
  const nativeMemoryProof = assertNativeMemoryDisabledProof(
    buildNativeMemoryDisabledProof({
      sessionInstanceId: input.sessionInstanceId,
      preparedMemorySessionId,
      binding: input.binding,
      agentKind: input.agentKind,
    }),
    {
      sessionInstanceId: input.sessionInstanceId,
      preparedMemorySessionId,
      agentKind: input.agentKind,
      binding: input.binding,
    },
  );
  assertNativeProofSchema(nativeMemoryProof, input.xdtMemoryRoot);

  if (!input.xdtReadOnlyScope) {
    throw new XdtPrepareError('CONFIG_INVALID', 'prepare must markXdtReadOnlyScope');
  }
  input.makerMemory.markXdtReadOnlyScope(input.xdtReadOnlyScope);

  return {
    preparedMemorySessionId,
    binding: input.binding,
    indexSnapshot: checked,
    nativeMemoryProof,
    records,
    sessionStore: createXdtFrozenSessionStore({ snapshot: checked, records }),
  };
}

async function loadIndexSnapshot(input: PrepareMemorySessionInput): Promise<FrozenIndexSnapshotV1> {
  if (!input.indexSource) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'prepareMemorySession must call xdt-memory memory_index; caller-supplied snapshot.content is forbidden',
    );
  }
  return readFrozenIndexFromXdt(input.indexSource, input.xdtMemoryRoot);
}

async function loadFacadeRecords(
  input: PrepareMemorySessionInput,
  snapshot: FrozenIndexSnapshotV1,
): Promise<readonly FrozenFacadeRecord[]> {
  if (snapshot.recordCount === 0) return [];
  if (!input.indexSource) {
    throw new XdtPrepareError(
      'INDEX_SNAPSHOT_MISMATCH',
      'facade records must be projected from the same memory_index snapshot',
    );
  }
  const client = (await import('./xdt-index.js')).createXdtMemoryIndexClient(
    input.indexSource,
    input.xdtMemoryRoot,
  );
  if (!client?.get) {
    throw new XdtPrepareError(
      'INDEX_SNAPSHOT_MISMATCH',
      'facade records must be projected from the same memory_index snapshot',
    );
  }
  const workspace = input.binding.canonicalWorkspaceId;
  return projectFacadeRecordsFromIndex({
    snapshot,
    getRecord: async (_filename, parsed) => {
      const canonicalKey = `${workspace}/${parsed.name}`;
      const byCanonical = await client.get?.(canonicalKey);
      if (byCanonical) return byCanonical;
      return (await client.get?.(parsed.name)) ?? null;
    },
  });
}
