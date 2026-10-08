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
let lastCleanConfigPath: string | null = null;

/**
 * sticky 只跳过「文件仍无 stanza」的重写：成功后再 ensure 时先读盘，用纯函数
 * `update(..., {state:'remove'})` 探测；next===existing 才短接。stanza 写回 /
 * 路径变了 / 坏 TOML → 清 sticky 再跑 remove。失败不 sticky。并发共用 inFlight。
 * 不要每个 createSession 无条件写 toml。
 */
async function fileStillHasNoStanza(
  overrides: Partial<RemoveIsolatedCodexXdtStanzaDeps>,
  configPath: string,
): Promise<boolean> {
  const userDataDir = overrides.userDataDir?.();
  if (!userDataDir) return false;
  const loaded = await coreDeps();
  const isolatedConfigPath = overrides.isolatedConfigPath ?? loaded.isolatedConfigPath;
  if (isolatedConfigPath(userDataDir) !== configPath) return false;

  let existing: string;
  try {
    existing = await fsp.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }

  const loadUpdate = overrides.loadUpdate ?? loaded.loadUpdate;
  try {
    const next = loadUpdate(overrides.xdtMemoryRoot)(existing, { state: 'remove' });
    return next === existing;
  } catch {
    // 坏 TOML / 非 contiguous：探测失败不得当「无 stanza」短接。
    return false;
  }
}

async function ensureOnce(
  overrides: Partial<RemoveIsolatedCodexXdtStanzaDeps>,
): Promise<RemoveIsolatedCodexXdtStanzaResult> {
  if (completed && lastCleanConfigPath) {
    if (await fileStillHasNoStanza(overrides, lastCleanConfigPath)) {
      return completed;
    }
    completed = null;
    lastCleanConfigPath = null;
  }
  try {
    const result = await removeIsolatedCodexXdtStanza(overrides);
    lastCleanConfigPath = result.configPath;
    completed = Promise.resolve(result);
    return result;
  } catch (err) {
    completed = null;
    lastCleanConfigPath = null;
    throw err;
  }
}

export function ensureIsolatedCodexXdtStanzaRemoved(
  overrides: Partial<RemoveIsolatedCodexXdtStanzaDeps> = {},
): Promise<RemoveIsolatedCodexXdtStanzaResult> {
  if (inFlight) return inFlight;
  inFlight = ensureOnce(overrides).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function resetIsolatedCodexXdtStanzaRemovalForTest(): void {
  completed = null;
  inFlight = null;
  lastCleanConfigPath = null;
}
