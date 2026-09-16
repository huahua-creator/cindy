/**
 * Effective writable Memory source inventory for Host-only xdt prepare.
 *
 * 阶段性 Cindy isolated Codex direct stanza 仍是第二个可写源。本刀不删 stanza。
 * 仅 Cindy Codex + provider=xdt 的 enabled prepare 因 stanza 返回
 * DUPLICATE_WRITABLE_MEMORY_SOURCE。Claude Code / Pi fixture 的 inventory 仍跑，
 * 但 Codex isolated stanza 不算进 Claude/Pi session 的 writable set。
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
