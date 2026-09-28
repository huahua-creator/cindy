/**
 * memory/_shared.ts
 *
 * 共享 helpers:
 *  - buildJsonResult: 拼成单 text MemoryToolResult, 跟 scheduler/_shared 同形
 *  - withStore:       按三路分流拿 Store, 自动 try/catch + 错误翻译
 *
 * 第 1 路现网 internal 无 binding 字段时继续 manager store。
 * 第 2 路 xdt 取 frozen store；accessor 失败不得 ?? deps.workdir。
 * 第 3 路 disabled 不进 store。
 */

import {
  resolveMemoryScopeKey,
  type MakerMemoryManager,
  type MakerMemoryStore,
  type MemorySessionStore,
} from '@cindy/maker-core';

import type { MemoryToolResult } from '../cindy_memoryToolRegistry.js';
import type { MemoryMcpDeps } from '../types.js';
import { classifyMemoryError } from './errors.js';
import { MemoryLaneError, resolveMemoryStore } from './resolve-store.js';

export function buildJsonResult(payload: unknown, isError = false): MemoryToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function xdtWriteForbiddenResult(): MemoryToolResult {
  return buildJsonResult(
    {
      ok: false,
      code: 'MAKER_MEMORY_NOT_READY',
      message: 'xdt prepared session is read-only; write/delete/consolidate/review are forbidden',
    },
    true,
  );
}

export function isXdtWriteNotApplicable(result: MemoryToolResult): boolean {
  try {
    const text = result.content[0] && 'text' in result.content[0] ? result.content[0].text : '';
    const parsed = JSON.parse(text) as { code?: unknown };
    return parsed.code === 'XDT_WRITE_NOT_APPLICABLE';
  } catch {
    return false;
  }
}

/**
 * 拿当前 session 绑定 workdir 的 Store. manager 不可用 (没注入 / disabled) 时
 * 返 MAKER_MEMORY_NOT_READY 错误, 调用方按 plan 决定是否提示用户开 mode。
 */
export type WithStoreContext = {
  store: MakerMemoryStore | MemorySessionStore;
  /** 解析后的 session scope key (linked worktree 已归一到主仓)。xdt 路为空。 */
  scopeKey: string;
  manager: MakerMemoryManager | null;
  lane: 'internal' | 'xdt' | 'disabled';
};

export async function withStore(
  deps: MemoryMcpDeps,
  fn: (store: MakerMemoryStore | MemorySessionStore, ctx: WithStoreContext) => Promise<unknown>,
): Promise<MemoryToolResult> {
  let store: MakerMemoryStore | MemorySessionStore;
  let manager: MakerMemoryManager | null = null;
  let scopeKey = '';
  let scopeAtEntry: string | null = null;
  let lane: 'internal' | 'xdt' | 'disabled' = 'internal';
  try {
    const ctx = deps.getSessionContext?.();
    const resolved = await resolveMemoryStore(deps, ctx);
    store = resolved.store;
    lane = resolved.lane;
    if (lane === 'internal') {
      manager = deps.getManager();
      if (!manager.isEnabled(ctx?.memoryScopeKey)) {
        return buildJsonResult(
          { ok: false, code: 'MAKER_MEMORY_NOT_READY', message: 'maker memory disabled (mode != "maker")' },
          true,
        );
      }
      scopeAtEntry = manager.currentOwnerScopeKey?.() ?? null;
      const workdir = ctx?.workingDir ?? deps.workdir;
      scopeKey =
        ctx?.memoryScopeKey ?? (await resolveMemoryScopeKey(workdir, ctx?.remoteHostId));
      manager = deps.getManager();
      if (scopeAtEntry !== null && manager.currentOwnerScopeKey?.() !== scopeAtEntry) {
        return buildJsonResult(
          {
            ok: false,
            code: 'MAKER_MEMORY_NOT_READY',
            message: 'owner scope changed during async memory operation; aborting (retry against current scope)',
          },
          true,
        );
      }
    }
  } catch (err) {
    if (err instanceof MemoryLaneError) {
      return buildJsonResult({ ok: false, code: err.code, message: err.message }, true);
    }
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
  try {
    const data = await fn(store, { store, scopeKey, manager, lane });
    if (lane === 'internal' && scopeAtEntry !== null && deps.getManager().currentOwnerScopeKey?.() !== scopeAtEntry) {
      return buildJsonResult(
        {
          ok: false,
          code: 'MAKER_MEMORY_NOT_READY',
          message: 'owner scope changed during memory operation; result not trusted',
        },
        true,
      );
    }
    return buildJsonResult({ ok: true, data });
  } catch (err) {
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
}
