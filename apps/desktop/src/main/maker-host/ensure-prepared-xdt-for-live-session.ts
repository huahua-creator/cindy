/**
 * 已开着的 Claude Code 会话：override 后把同一 MCP ctx 解冻到当前 committed xdt。
 * 必须 mutate startSession 登记的同一对象引用；找不到引用则 forget Host prepared，禁止新建 ctx。
 */

import {
  getLiveClaudeMcpContext,
  type CreateSessionOptions,
  type PreparedMemorySession,
} from '@cindy/maker-core';
import type { LiziMcpSessionContext } from '@cindy/mcps';

import { attachSessionWorkspaceIdentity } from './attach-session-workspace-identity.js';
import { PRODUCTION_WRITE_WORKSPACE } from './facade-write-target.js';
import { isCurrentProductionXdtPrepared } from './current-production-xdt-prepared.js';
import { prepareReadonlyXdtSession } from './prepare-readonly-xdt-session.js';
import {
  forgetPreparedMemorySessionForSessionId,
  getPreparedMemorySessionForSessionId,
} from './prepared-memory-sessions.js';
import { resolveEffectiveProvider } from './resolve-effective-memory-provider.js';
import { getSessionWorkspaceIdentity } from './session-workspace-identity.js';
import {
  loadMemoryProviderSettings,
  type RegistryOwnerScope,
} from './workspace-identity-registry.js';
import { resolveOwnerScopedRegistryRoot } from './workspace-identity-assembler.js';

export const XDT_WRITE_NOT_APPLICABLE = {
  ok: false,
  code: 'XDT_WRITE_NOT_APPLICABLE',
  message: 'xdt write is not applicable for this session; fall back to internal store',
} as const;

function clearLiveBinding(ctx: LiziMcpSessionContext): void {
  delete ctx.memoryBinding;
  delete ctx.preparedMemorySessionId;
  delete ctx.preparedMemorySession;
}

function assignLiveBinding(ctx: LiziMcpSessionContext, prepared: PreparedMemorySession): void {
  ctx.memoryBinding = prepared.binding;
  ctx.preparedMemorySessionId = prepared.preparedMemorySessionId;
  ctx.preparedMemorySession = prepared;
}

export interface EnsurePreparedXdtForLiveSessionDeps {
  getOwner?: () => RegistryOwnerScope;
  attach?: typeof attachSessionWorkspaceIdentity;
  prepare?: typeof prepareReadonlyXdtSession;
  loadSettings?: typeof loadMemoryProviderSettings;
  getLiveContext?: typeof getLiveClaudeMcpContext;
  getPreparedForSession?: typeof getPreparedMemorySessionForSessionId;
  forgetPreparedForSession?: typeof forgetPreparedMemorySessionForSessionId;
}

export type EnsurePreparedXdtResult =
  | { status: 'ready'; prepared: PreparedMemorySession; context: LiziMcpSessionContext }
  | { status: 'not_applicable'; code: 'XDT_WRITE_NOT_APPLICABLE' }
  | { status: 'failed'; code: 'MAKER_MEMORY_NOT_READY' | 'CONFIG_INVALID' };

export async function ensurePreparedXdtForLiveSession(
  sessionId: string,
  deps: EnsurePreparedXdtForLiveSessionDeps = {},
): Promise<EnsurePreparedXdtResult> {
  const getLive = deps.getLiveContext ?? getLiveClaudeMcpContext;
  const forget = deps.forgetPreparedForSession ?? forgetPreparedMemorySessionForSessionId;
  const getPrepared = deps.getPreparedForSession ?? getPreparedMemorySessionForSessionId;
  const live = getLive(sessionId) as LiziMcpSessionContext | undefined;
  if (!live) {
    forget(sessionId);
    return { status: 'failed', code: 'MAKER_MEMORY_NOT_READY' };
  }
  if (live.agentKind !== 'claude-code' || live.remoteHostId) {
    return { status: 'not_applicable', code: 'XDT_WRITE_NOT_APPLICABLE' };
  }

  const owner = (deps.getOwner ?? resolveOwnerScopedRegistryRoot)();
  const attach = deps.attach ?? attachSessionWorkspaceIdentity;
  const prepare = deps.prepare ?? prepareReadonlyXdtSession;
  const loadSettings = deps.loadSettings ?? loadMemoryProviderSettings;

  const opts: CreateSessionOptions = {
    agentKind: 'claude-code',
    workingDir: live.workingDir,
    model: '',
    sessionInstanceId: live.sessionInstanceId,
    makerMemoryEnabled: true,
    preparedMemorySession: getPrepared(sessionId) ?? live.preparedMemorySession,
  };

  await attach(sessionId, opts);
  const identity = getSessionWorkspaceIdentity(sessionId);
  const settings = await loadSettings(owner);
  const effective = resolveEffectiveProvider({
    remoteHostId: live.remoteHostId,
    canonicalWorkspaceId: identity?.canonicalWorkspaceId,
    settings: settings.settings,
  });
  if (effective !== 'xdt' || identity?.canonicalWorkspaceId !== PRODUCTION_WRITE_WORKSPACE) {
    return { status: 'not_applicable', code: 'XDT_WRITE_NOT_APPLICABLE' };
  }

  const current = getPrepared(sessionId) ?? opts.preparedMemorySession;
  if (isCurrentProductionXdtPrepared({
    prepared: current,
    committedConfigGeneration: settings.settings?.configGeneration,
  }) && current) {
    assignLiveBinding(live, current);
    return { status: 'ready', prepared: current, context: live };
  }

  forget(sessionId);
  clearLiveBinding(live);
  delete opts.preparedMemorySession;

  try {
    await prepare(sessionId, opts);
  } catch (err) {
    clearLiveBinding(live);
    forget(sessionId);
    throw err;
  }

  const prepared = opts.preparedMemorySession ?? getPrepared(sessionId);
  if (!prepared || !isCurrentProductionXdtPrepared({
    prepared,
    committedConfigGeneration: settings.settings?.configGeneration,
  })) {
    clearLiveBinding(live);
    forget(sessionId);
    return { status: 'not_applicable', code: 'XDT_WRITE_NOT_APPLICABLE' };
  }
  assignLiveBinding(live, prepared);
  return { status: 'ready', prepared, context: live };
}
