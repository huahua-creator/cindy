/**
 * 段 4：Host-only 内存快照。createSession 只消费已确认 UUID。
 * 有 UUID ≠ 启用 xdt ≠ prepareMemorySession。
 * 不写 sqlite / SessionMeta / memory-settings.json。进程崩溃后快照会丢。
 */

export interface SessionWorkspaceIdentity {
  canonicalWorkspaceId: string;
  locatorDigest: string;
}

const snapshots = new Map<string, SessionWorkspaceIdentity>();

export function rememberSessionWorkspaceIdentity(
  sessionId: string,
  identity: SessionWorkspaceIdentity,
): void {
  snapshots.set(sessionId, identity);
}

export function getSessionWorkspaceIdentity(
  sessionId: string,
): SessionWorkspaceIdentity | undefined {
  return snapshots.get(sessionId);
}

export function forgetSessionWorkspaceIdentity(sessionId: string): void {
  snapshots.delete(sessionId);
}

export function resetSessionWorkspaceIdentityForTest(): void {
  snapshots.clear();
}
