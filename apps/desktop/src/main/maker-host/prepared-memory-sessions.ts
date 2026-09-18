/**
 * Host-only in-memory registry for xdt PreparedMemorySession.
 * 段 1 fixture 与段 5 生产只读 prepare 共用 remember / get / forget。
 * forget 的键永远是 preparedId，禁止 forgetPreparedMemorySession(sessionId)。
 */

import {
  prepareMemorySession,
  type PreparedMemorySession,
  type PrepareMemorySessionInput,
} from '@cindy/maker-core';

const sessions = new Map<string, PreparedMemorySession>();
const sessionIdToPreparedId = new Map<string, string>();

export function rememberPreparedMemorySession(session: PreparedMemorySession): void {
  sessions.set(session.preparedMemorySessionId, session);
}

export function bindPreparedMemorySessionToSessionId(
  sessionId: string,
  preparedMemorySessionId: string,
): void {
  sessionIdToPreparedId.set(sessionId, preparedMemorySessionId);
}

export function getPreparedMemorySession(
  preparedMemorySessionId: string,
): PreparedMemorySession | undefined {
  return sessions.get(preparedMemorySessionId);
}

export function forgetPreparedMemorySession(preparedMemorySessionId: string): void {
  sessions.delete(preparedMemorySessionId);
}

export function forgetPreparedMemorySessionForSessionId(sessionId: string): void {
  const preparedId = sessionIdToPreparedId.get(sessionId);
  sessionIdToPreparedId.delete(sessionId);
  if (preparedId) forgetPreparedMemorySession(preparedId);
}

export function resetPreparedMemorySessionsForTest(): void {
  sessions.clear();
  sessionIdToPreparedId.clear();
}

/** Host fixture / 生产只读入口：调 memory_index、冻结、markXdtReadOnlyScope、登记。 */
export async function prepareAndRememberMemorySession(
  input: PrepareMemorySessionInput,
): Promise<PreparedMemorySession> {
  const session = await prepareMemorySession(input);
  rememberPreparedMemorySession(session);
  return session;
}
