/**
 * Host-only in-memory registry for xdt PreparedMemorySession.
 * 本刀只服务 fixture UUID + fixture repo，不读生产 xdt data。
 * 产品入口：temp UUID 树 → memory_index → prepareAndRemember → createSession({ preparedMemorySession })。
 */

import {
  prepareMemorySession,
  type PreparedMemorySession,
  type PrepareMemorySessionInput,
} from '@cindy/maker-core';

const sessions = new Map<string, PreparedMemorySession>();

export function rememberPreparedMemorySession(session: PreparedMemorySession): void {
  sessions.set(session.preparedMemorySessionId, session);
}

export function getPreparedMemorySession(
  preparedMemorySessionId: string,
): PreparedMemorySession | undefined {
  return sessions.get(preparedMemorySessionId);
}

export function forgetPreparedMemorySession(preparedMemorySessionId: string): void {
  sessions.delete(preparedMemorySessionId);
}

/** Host fixture 入口：调 memory_index、冻结、markXdtReadOnlyScope、登记。 */
export async function prepareAndRememberMemorySession(
  input: PrepareMemorySessionInput,
): Promise<PreparedMemorySession> {
  const session = await prepareMemorySession(input);
  rememberPreparedMemorySession(session);
  return session;
}
