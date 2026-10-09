import { snapshotClaudeMcpExclusions } from '@cindy/maker-core';

/** Presence is independent of list length: [] is an explicit diagnostic baseline. */
export function readHandoffMcpProfile(input: {
  claudeExcludedMcpServers?: unknown;
  targetSessionId?: unknown;
  dispatcherSessionId?: unknown;
  execution?: unknown;
  workingDir?: unknown;
  useWorktree?: unknown;
}): { ok: true; requested: boolean; names: readonly string[] } | {
  ok: false; errorCode: 'INVALID_ARGS'; message: string;
} {
  if (input.claudeExcludedMcpServers === undefined) return { ok: true, requested: false, names: [] };
  if (input.targetSessionId !== undefined || typeof input.dispatcherSessionId !== 'string'
    || !input.dispatcherSessionId.trim() || input.execution !== undefined
    || input.workingDir !== undefined || (input.useWorktree !== undefined && input.useWorktree !== false)) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: 'Diagnostic MCP profiles require create from the current local Claude session without execution, directory or worktree overrides.' };
  }
  try {
    return { ok: true, requested: true, names: snapshotClaudeMcpExclusions({
      vendorOptions: { claudeExcludedMcpServers: input.claudeExcludedMcpServers },
    }) };
  } catch (error) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: error instanceof Error ? error.message : 'Invalid MCP profile' };
  }
}

export interface HandoffRuntimeSession {
  id: string;
  readonly instanceId: string;
  agentKind: string;
  model: string;
  remoteHostId?: string | null;
  getStatus(): string;
  hasStartedClosing(): boolean;
}
export interface HandoffRuntimeRoute {
  model: string;
  providerId: string;
  effort: string | undefined;
  fastMode: boolean;
  providerRevision: number;
}
export interface HandoffRuntimeSnapshot {
  owner: object;
  scopeGeneration: number;
  instance: HandoffRuntimeSession;
  instanceId: string;
  generation: number;
  route: HandoffRuntimeRoute;
}
export interface HandoffRuntimeReaders {
  owner(): object | null;
  scopeGeneration(): number;
  boundaryPending(): boolean;
  session(id: string): HandoffRuntimeSession | undefined;
  control(id: string): { generation: number; pending: unknown };
  provider(id: string): string | null | undefined;
  effort(id: string): string | null | undefined;
  fast(id: string): boolean;
  providerRevision(id: string): number;
}

/** One synchronous, epoch-bound tuple; never splice getters across a route transition. */
export function snapshotHandoffRuntime(id: string, read: HandoffRuntimeReaders,
  expected?: Pick<HandoffRuntimeSnapshot, 'owner' | 'scopeGeneration'> & Partial<Pick<HandoffRuntimeSnapshot, 'instance' | 'instanceId' | 'generation'>>,
): HandoffRuntimeSnapshot {
  const owner = read.owner();
  const scopeGeneration = read.scopeGeneration();
  const instance = read.session(id);
  const control = read.control(id);
  const generation = control.generation;
  if (!owner || read.boundaryPending() || !instance || instance.agentKind !== 'claude-code' || instance.remoteHostId
    || instance.getStatus() !== 'active' || instance.hasStartedClosing() || control.pending != null) {
    throw new Error('Diagnostic runtime is unavailable or changing');
  }
  const model = instance.model;
  const instanceId = instance.instanceId;
  const providerId = read.provider(id);
  if (!providerId) throw new Error('Diagnostic requires an explicit connected provider route');
  const providerRevision = read.providerRevision(providerId);
  const route = Object.freeze({ model, providerId, effort: read.effort(id) ?? undefined,
    fastMode: read.fast(id), providerRevision });
  const after = read.control(id);
  if (read.boundaryPending() || read.owner() !== owner || read.scopeGeneration() !== scopeGeneration
    || read.session(id) !== instance || instance.instanceId !== instanceId || after.generation !== generation || after.pending != null
    || read.providerRevision(providerId) !== providerRevision
    || (expected && (expected.owner !== owner || expected.scopeGeneration !== scopeGeneration
      || (expected.instance !== undefined && expected.instance !== instance)
      || (expected.instanceId !== undefined && expected.instanceId !== instanceId)
      || (expected.generation !== undefined && expected.generation !== generation)))) {
    throw new Error('Diagnostic owner, instance or route changed');
  }
  return { owner, scopeGeneration, instance, instanceId, generation, route };
}

export function sameHandoffRuntimeRoute(a: HandoffRuntimeRoute, b: HandoffRuntimeRoute): boolean {
  return a.model === b.model && a.providerId === b.providerId && a.effort === b.effort
    && a.fastMode === b.fastMode && a.providerRevision === b.providerRevision;
}

export interface HandoffDiagnosticFailure {
  targetSessionId?: string;
  dispatchStarted: boolean;
  draftState: 'not-created' | 'preserved-closed' | 'cleanup-incomplete';
}

/** Only non-sensitive routing/authority fields participate in the final source recheck. */
export function handoffMcpSourceFingerprint(row: Record<string, unknown> | undefined): string {
  return JSON.stringify(['status', 'source', 'agentKind', 'remoteHostId', 'orcaRole', 'model', 'providerId',
    'effort', 'fastMode', 'workingDir', 'workspaceKind'].map(key => row?.[key] ?? null));
}
