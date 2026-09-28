/**
 * H-Bus cindy_memory.create/update → 1c facade upsert。
 * Claude 与本地 Codex 可写；Pi / remote / 缺 session 身份仍红。
 */

import type { PreparedMemorySession } from '@cindy/maker-core';
import { XdtPrepareError } from '@cindy/maker-core';
import type { MemoryMcpDeps } from '@cindy/mcps';

import {
  executeFacadeMemoryWrite,
  MemoryFacadeError,
  XDT_WRITE_FORBIDDEN,
  type MemoryFacadeDynamicToolDeps,
} from './memory-facade-codex-dynamic-tools.js';
import { FacadeWriteError } from './facade-xdt-write.js';
import { FacadeWriteTargetError } from './facade-write-target.js';
import {
  FacadeInvocationLedgerError,
  listInvocationLedgersForTurn,
  readInvocationLedger,
} from './facade-invocation-ledger.js';
import { FacadeJournalError } from './facade-journal.js';
import { FacadeSecretError } from './facade-capability-secret.js';
import { resolveHostFacadeWriteTarget } from './resolve-host-facade-write-target.js';
import {
  ensurePreparedXdtForLiveSession,
  XDT_WRITE_NOT_APPLICABLE,
  type EnsurePreparedXdtForLiveSessionDeps,
} from './ensure-prepared-xdt-for-live-session.js';
import { isCurrentProductionXdtPrepared } from './current-production-xdt-prepared.js';
import { loadMemoryProviderSettings } from './workspace-identity-registry.js';
import type { RegistryOwnerScope } from './workspace-identity-registry.js';

type ExecuteInput = Parameters<NonNullable<MemoryMcpDeps['executeXdtFacadeWrite']>>[0];
type ExecuteResult = Awaited<ReturnType<NonNullable<MemoryMcpDeps['executeXdtFacadeWrite']>>>;

function jsonResult(payload: unknown, isError = false): ExecuteResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function forbidden(): ExecuteResult {
  return jsonResult(XDT_WRITE_FORBIDDEN, true);
}

function notApplicable(): ExecuteResult {
  return jsonResult(XDT_WRITE_NOT_APPLICABLE, true);
}

function errorResult(code: string, message: string): ExecuteResult {
  return jsonResult({ ok: false, code, message }, true);
}

function mapErr(err: unknown): ExecuteResult {
  if (err instanceof MemoryFacadeError) {
    return errorResult(err.code, err.message.replace(/^INVALID_ARGS: /, ''));
  }
  if (
    err instanceof FacadeInvocationLedgerError
    || err instanceof FacadeJournalError
    || err instanceof XdtPrepareError
    || err instanceof FacadeSecretError
    || err instanceof FacadeWriteTargetError
    || err instanceof FacadeWriteError
  ) {
    return errorResult(err.code, err.message.replace(/^[A-Z_]+: /, ''));
  }
  const code = (err as { code?: string }).code;
  if (typeof code === 'string' && code.length > 0 && code === code.toUpperCase()) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(code, message.replace(/^[A-Z_]+: /, ''));
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('JOURNAL_BUSY')) {
    return errorResult('JOURNAL_BUSY', 'facade journal is busy');
  }
  return errorResult('INTERNAL', 'host facade call failed');
}

export interface HbusXdtFacadeWriteDeps {
  getOwner: () => RegistryOwnerScope;
  getCapabilitySecret: MemoryFacadeDynamicToolDeps['getCapabilitySecret'];
  getPreparedMemorySession: (preparedMemorySessionId: string) => PreparedMemorySession | undefined;
  resolveWriteRoots: () => { repoRoot: string; dataRoot: string };
  createWriteStore?: MemoryFacadeDynamicToolDeps['createWriteStore'];
  now?: MemoryFacadeDynamicToolDeps['now'];
  randomUuid?: MemoryFacadeDynamicToolDeps['randomUuid'];
  ensurePrepared?: typeof ensurePreparedXdtForLiveSession;
  ensureDeps?: EnsurePreparedXdtForLiveSessionDeps;
  loadSettings?: (owner: RegistryOwnerScope) => Promise<{
    status: string;
    settings?: { configGeneration?: string };
  }>;
}

export async function executeHbusXdtFacadeWrite(
  input: ExecuteInput,
  deps: HbusXdtFacadeWriteDeps,
): Promise<ExecuteResult> {
  const agentKind = input.sessionContext.agentKind;
  if (agentKind !== 'claude-code' && agentKind !== 'codex') {
    return forbidden();
  }
  const sessionId = input.sessionContext.sessionId;
  const sessionInstanceId = input.sessionContext.sessionInstanceId;
  if (!sessionId || !sessionInstanceId) {
    return forbidden();
  }
  if (input.sessionContext.remoteHostId) {
    return notApplicable();
  }
  const owner = deps.getOwner();
  const preparedId = input.sessionContext.preparedMemorySessionId;
  let prepared = preparedId ? deps.getPreparedMemorySession(preparedId) : undefined;
  const loadSettings = deps.loadSettings ?? loadMemoryProviderSettings;
  let committedGeneration: string | undefined;
  try {
    committedGeneration = (await loadSettings(owner)).settings?.configGeneration;
  } catch {
    committedGeneration = undefined;
  }
  if (!isCurrentProductionXdtPrepared({ prepared, committedConfigGeneration: committedGeneration })) {
    if (agentKind !== 'claude-code') {
      return notApplicable();
    }
    const ensure = deps.ensurePrepared ?? ensurePreparedXdtForLiveSession;
    const ensured = await ensure(sessionId, deps.ensureDeps);
    if (ensured.status === 'failed') return forbidden();
    if (ensured.status === 'not_applicable') return notApplicable();
    prepared = ensured.prepared;
  }
  if (!prepared) {
    return notApplicable();
  }
  const roots = deps.resolveWriteRoots();
  const writeTarget = await resolveHostFacadeWriteTarget({
    prepared,
    owner,
    repoRoot: roots.repoRoot,
    dataRoot: roots.dataRoot,
    remoteHostId: input.sessionContext.remoteHostId,
  });
  if (!writeTarget) {
    return notApplicable();
  }
  if (agentKind === 'codex') {
    const identity = {
      threadId: sessionId,
      turnId: sessionInstanceId,
      callId: input.callId,
    };
    const existing = await readInvocationLedger(owner, identity);
    if (!existing) {
      const siblings = await listInvocationLedgersForTurn(owner, {
        threadId: sessionId,
        turnId: sessionInstanceId,
      });
      if (siblings.length > 0) {
        return forbidden();
      }
    }
  }
  const facadeDeps: MemoryFacadeDynamicToolDeps = {
    getOwner: deps.getOwner,
    getCapabilitySecret: deps.getCapabilitySecret,
    getPreparedBySessionId: () => prepared,
    getWriteTarget: () => writeTarget,
    createWriteStore: deps.createWriteStore,
    now: deps.now,
    randomUuid: deps.randomUuid,
    allowProductionWorkspace: true,
    allowProductionTree: true,
  };
  try {
    const result = await executeFacadeMemoryWrite({
      deps: facadeDeps,
      owner,
      prepared,
      identity: {
        threadId: sessionId,
        // MCP session id is connection-scoped and must not enter the ledger key.
        turnId: sessionInstanceId,
        callId: input.callId,
      },
      innerName: 'memory_write',
      innerArgs: input.args,
      writeTarget,
    });
    return jsonResult({ ok: true, data: result });
  } catch (err) {
    return mapErr(err);
  }
}

export function createHbusXdtFacadeWrite(
  deps: HbusXdtFacadeWriteDeps,
): NonNullable<MemoryMcpDeps['executeXdtFacadeWrite']> {
  return (input) => executeHbusXdtFacadeWrite(input, deps);
}
