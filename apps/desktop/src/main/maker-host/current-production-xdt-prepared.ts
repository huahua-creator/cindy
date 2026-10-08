/**
 * 当前 committed 生产 workspace 上的 xdt prepared 才算有效。
 * SETTINGS_UNCHANGED_SENTINEL 禁止当 configGeneration。
 */

import { loadXdtSchemaValidator, type PreparedMemorySession } from '@cindy/maker-core';

import { PRODUCTION_WRITE_WORKSPACE } from './facade-write-target.js';

export function isCurrentProductionXdtPrepared(input: {
  prepared: PreparedMemorySession | undefined;
  committedConfigGeneration: string | undefined;
}): boolean {
  const prepared = input.prepared;
  const generation = input.committedConfigGeneration?.trim();
  if (!prepared || !generation) return false;
  if (generation === loadXdtSchemaValidator().SETTINGS_UNCHANGED_SENTINEL.generation) {
    return false;
  }
  return (
    prepared.binding.provider === 'xdt'
    && prepared.binding.canonicalWorkspaceId === PRODUCTION_WRITE_WORKSPACE
    && prepared.binding.configGeneration === generation
  );
}
