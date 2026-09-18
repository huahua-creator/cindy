/**
 * 段 6：去掉 Cindy 隔离 Codex home 里的可写 xdt-memory stanza。
 *
 * 只动 userData/codex-home/config.toml。禁止读/写用户 Codex CLI 默认 home。
 * 删除走 xdt-memory 纯函数 updateCindyCodexConfig({state:'remove'})，禁止 spawn CLI。
 * 文件不存在 = 已无 stanza，不 mkdir、不写空文件。坏 TOML → CONFIG_INVALID，字节不变。
 * 禁止用 stanza 存在性探测的 catch-false 当清理权威。
 *
 * maker-core 用运行时 import，避免 auth-adapters 的空 mock 在 import 时炸掉。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { UpdateCindyCodexConfigFn } from '@cindy/maker-core';

import { writeFileAtomicIfUnchanged } from './codex-global-plugins.js';

export interface RemoveIsolatedCodexXdtStanzaDeps {
  userDataDir: () => string;
  loadUpdate: (root?: string) => UpdateCindyCodexConfigFn;
  isolatedConfigPath: (userDataDir: string) => string;
  invalid: (message: string) => Error;
  xdtMemoryRoot?: string;
}

export interface RemoveIsolatedCodexXdtStanzaResult {
  status: 'missing' | 'unchanged' | 'removed';
  configPath: string;
}

async function coreDeps(): Promise<Pick<RemoveIsolatedCodexXdtStanzaDeps, 'loadUpdate' | 'isolatedConfigPath' | 'invalid'>> {
  const {
    XdtPrepareError,
    cindyIsolatedCodexConfigPath,
    loadUpdateCindyCodexConfig,
  } = await import('@cindy/maker-core');
  return {
    loadUpdate: loadUpdateCindyCodexConfig,
    isolatedConfigPath: cindyIsolatedCodexConfigPath,
    invalid: (message) => new XdtPrepareError('CONFIG_INVALID', message),
  };
}

function wrapTomlFailure(err: unknown, invalid: (message: string) => Error): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'CONFIG_INVALID') {
    throw err;
  }
  throw invalid(
    `isolated Codex config.toml cannot be cleaned: ${err instanceof Error ? err.message : String(err)}`,
  );
}

export async function removeIsolatedCodexXdtStanza(
  overrides: Partial<RemoveIsolatedCodexXdtStanzaDeps> = {},
): Promise<RemoveIsolatedCodexXdtStanzaResult> {
  const loaded = await coreDeps();
  const deps = { ...loaded, ...overrides };
  if (!overrides.userDataDir) {
    throw deps.invalid(
      'userDataDir must be injected; empty default would resolve a relative Codex stanza path',
    );
  }
  const userDataDir = overrides.userDataDir();
  if (!userDataDir) {
    throw deps.invalid(
      'userDataDir must be injected; empty default would resolve a relative Codex stanza path',
    );
  }
  const configPath = deps.isolatedConfigPath(userDataDir);
  if (path.basename(path.dirname(configPath)) !== 'codex-home' || path.basename(configPath) !== 'config.toml') {
    throw deps.invalid('isolated Codex stanza path must be userData/codex-home/config.toml');
  }

  let existing: string;
  try {
    existing = await fsp.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', configPath };
    }
    throw err;
  }

  const update = deps.loadUpdate(deps.xdtMemoryRoot);
  let next: string;
  try {
    next = update(existing, { state: 'remove' });
  } catch (err) {
    wrapTomlFailure(err, deps.invalid);
  }

  if (next === existing) {
    return { status: 'unchanged', configPath };
  }

  const applied = await writeFileAtomicIfUnchanged(configPath, next, existing);
  if (!applied) {
    throw deps.invalid('isolated Codex config.toml changed concurrently during stanza removal');
  }
  return { status: 'removed', configPath };
}

let completed: Promise<RemoveIsolatedCodexXdtStanzaResult> | null = null;
let inFlight: Promise<RemoveIsolatedCodexXdtStanzaResult> | null = null;

/**
 * 进程内 once：成功后不再重写 toml。失败（坏 TOML）不 sticky，下次仍 fail-closed。
 * 并发调用复用同一 Promise。
 */
export function ensureIsolatedCodexXdtStanzaRemoved(
  overrides: Partial<RemoveIsolatedCodexXdtStanzaDeps> = {},
): Promise<RemoveIsolatedCodexXdtStanzaResult> {
  if (completed) return completed;
  if (!inFlight) {
    inFlight = removeIsolatedCodexXdtStanza(overrides).then(
      (result) => {
        completed = Promise.resolve(result);
        inFlight = null;
        return result;
      },
      (err) => {
        inFlight = null;
        throw err;
      },
    );
  }
  return inFlight;
}

export function resetIsolatedCodexXdtStanzaRemovalForTest(): void {
  completed = null;
  inFlight = null;
}
