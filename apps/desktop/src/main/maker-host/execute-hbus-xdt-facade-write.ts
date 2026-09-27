/**
 * H-Bus cindy_memory.create/update → 1c facade upsert。
 * 本刀仅 Claude；Codex/Pi 继续红。缺 sessionId/sessionInstanceId/writeTarget 不 mint。
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
import { FacadeInvocationLedgerError } from './facade-invocation-ledger.js';
import { FacadeJournalError } from './facade-journal.js';
import { FacadeSecretError } from './facade-capability-secret.js';
import { resolveHostFacadeWriteTarget } from './resolve-host-facade-write-target.js';
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
}

export async function executeHbusXdtFacadeWrite(
  input: ExecuteInput,
  deps: HbusXdtFacadeWriteDeps,
): Promise<ExecuteResult> {
  if (input.sessionContext.agentKind !== 'claude-code') {
    return forbidden();
  }
  const sessionId = input.sessionContext.sessionId;
  const sessionInstanceId = input.sessionContext.sessionInstanceId;
  if (!sessionId || !sessionInstanceId) {
    return forbidden();
  }
  const preparedId = input.sessionContext.preparedMemorySessionId;
  const prepared = preparedId ? deps.getPreparedMemorySession(preparedId) : undefined;
  if (!prepared) {
    return forbidden();
  }
  const owner = deps.getOwner();
  const roots = deps.resolveWriteRoots();
  const writeTarget = await resolveHostFacadeWriteTarget({
    prepared,
    owner,
    repoRoot: roots.repoRoot,
    dataRoot: roots.dataRoot,
    remoteHostId: input.sessionContext.remoteHostId,
  });
  if (!writeTarget) {
    return forbidden();
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
        turnId: input.mcpSessionId ?? sessionInstanceId,
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
