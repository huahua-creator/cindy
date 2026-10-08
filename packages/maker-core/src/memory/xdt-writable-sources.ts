/**
 * Effective writable Memory source inventory for Host-only xdt prepare.
 *
 * 生产隔离 home 不得再有可写 xdt stanza（段 6 用户授权取代「不得删除阶段性 stanza」）。
 * 检测函数仍用于 fail-closed：Cindy Codex + provider=xdt 的 enabled prepare
 * 若 stanza 仍在，返回 DUPLICATE_WRITABLE_MEMORY_SOURCE。Claude Code / Pi
 * 即使 stanza 在也不算进 writable set。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { AgentKind } from '../types/common.js';
import { XdtPrepareError } from './xdt-binding.js';

const XDT_STANZA = /\[mcp_servers\.xdt-memory\]/;

/**
 * 不要默认读 `~/.codex/config.toml`。Cindy isolated stanza 在 userData/codex-home。
 * 调用方必须显式传入 Cindy 自管 config 路径；生产误用不得扫错文件。
 */
export function defaultCindyCodexConfigPath(): string {
  throw new XdtPrepareError(
    'CONFIG_INVALID',
    'Cindy isolated Codex stanza is under userData/codex-home; pass that config.toml explicitly',
  );
}

export function cindyIsolatedCodexConfigPath(userDataDir: string): string {
  return path.join(userDataDir, 'codex-home', 'config.toml');
}

export function isolatedCodexStanzaPresent(configToml: string): boolean {
  return XDT_STANZA.test(configToml);
}

export function readIsolatedCodexStanzaPresent(configPath: string): boolean {
  if (!configPath) {
    throw new XdtPrepareError('CONFIG_INVALID', 'isolated Codex stanza path is required');
  }
  try {
    return isolatedCodexStanzaPresent(readFileSync(configPath, 'utf8'));
  } catch {
    return false;
  }
}

export function assertNoDuplicateWritableMemorySource(input: {
  agentKind: AgentKind;
  isolatedStanzaPresent: boolean;
}): void {
  if (input.agentKind === 'codex' && input.isolatedStanzaPresent) {
    throw new XdtPrepareError(
      'DUPLICATE_WRITABLE_MEMORY_SOURCE',
      'Cindy Codex xdt enabled prepare is blocked while isolated Codex stanza remains',
    );
  }
}
