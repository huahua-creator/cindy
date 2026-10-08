/**
 * cindy_memory 三路分流 resolver。
 *
 * 判定顺序固定：先看是否已有 XdtMemoryBindingV1 / 请求 xdt，再看是否命中第 3 路，
 * 其余才是第 1 路。禁止把「ctx 无 memoryBinding 字段」当成第 3 路。
 */

import {
  isXdtMemoryBinding,
  resolveMemoryScopeKey,
  type MakerMemoryStore,
  type MemorySessionStore,
  type PreparedMemorySession,
} from '@cindy/maker-core';

import type { LiziMcpSessionContext, MemoryMcpDeps } from '../types.js';
import { classifyMemoryError } from './errors.js';

export type MemoryLane = 'internal' | 'xdt' | 'disabled';

export function classifyMemoryLane(ctx: LiziMcpSessionContext | undefined): MemoryLane {
  if (ctx?.memoryBinding && isXdtMemoryBinding(ctx.memoryBinding)) return 'xdt';
  if (ctx?.preparedMemorySessionId) return 'disabled';
  if (ctx?.memoryBinding) return 'disabled';
  if (ctx?.memoryProviderRequested === 'xdt') return 'disabled';
  return 'internal';
}

export class MemoryLaneError extends Error {
  readonly code: 'MAKER_MEMORY_NOT_READY' | 'XDT_WRITE_FORBIDDEN';

  constructor(code: 'MAKER_MEMORY_NOT_READY' | 'XDT_WRITE_FORBIDDEN', message: string) {
    super(message);
    this.name = 'MemoryLaneError';
    this.code = code;
  }
}

export async function resolveMemoryStore(
  deps: MemoryMcpDeps,
  ctx: LiziMcpSessionContext | undefined,
): Promise<{ lane: MemoryLane; store: MakerMemoryStore | MemorySessionStore; prepared?: PreparedMemorySession }> {
  const lane = classifyMemoryLane(ctx);
  if (lane === 'xdt') {
    const preparedId = ctx?.preparedMemorySessionId;
    const prepared =
      ctx?.preparedMemorySession ??
      (preparedId ? deps.getPreparedMemorySession?.(preparedId) : undefined);
    if (!prepared || !isXdtMemoryBinding(prepared.binding)) {
      throw new MemoryLaneError(
        'MAKER_MEMORY_NOT_READY',
        'xdt prepared session accessor returned undefined',
      );
    }
    if (!ctx?.workingDir) {
      throw new MemoryLaneError(
        'MAKER_MEMORY_NOT_READY',
        'xdt prepared session workdir is empty',
      );
    }
    return { lane, store: prepared.sessionStore, prepared };
  }

  if (lane === 'disabled') {
    throw new MemoryLaneError(
      'MAKER_MEMORY_NOT_READY',
      'maker memory disabled for this session',
    );
  }

  const manager = deps.getManager();
  if (!manager.isEnabled(ctx?.memoryScopeKey)) {
    throw new MemoryLaneError(
      'MAKER_MEMORY_NOT_READY',
      'maker memory disabled (mode != "maker")',
    );
  }
  const workdir = ctx?.workingDir ?? deps.workdir;
  const scopeKey =
    ctx?.memoryScopeKey ?? (await resolveMemoryScopeKey(workdir, ctx?.remoteHostId));
  const store = await manager.getStore(scopeKey);
  return { lane: 'internal', store };
}

export { classifyMemoryError };
