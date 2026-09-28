/**
 * 生产 cindy_memory 写目标：Host 显式注入根，不继承 prepared 只读 index。
 * settings recover 后 committed 且 workspace 正是 dc703d5e 才返回 target。
 * 沙盒 UUID / remote / review / 缺 prepared / settings missing → undefined。
 */

import type { PreparedMemorySession } from '@cindy/maker-core';
import { isXdtMemoryBinding, XdtPrepareError } from '@cindy/maker-core';

import {
  PRODUCTION_WRITE_WORKSPACE,
  type FacadeWriteTarget,
} from './facade-write-target.js';
import {
  loadMemoryProviderSettings,
  readTransaction,
  type RegistryOwnerScope,
} from './workspace-identity-registry.js';

export async function resolveHostFacadeWriteTarget(input: {
  prepared: PreparedMemorySession | undefined;
  owner: RegistryOwnerScope;
  repoRoot: string;
  dataRoot: string;
  remoteHostId?: string;
  reviewMode?: boolean;
  loadSettings?: typeof loadMemoryProviderSettings;
  readTxn?: typeof readTransaction;
}): Promise<FacadeWriteTarget | undefined> {
  if (input.reviewMode || input.remoteHostId) return undefined;
  const prepared = input.prepared;
  if (!prepared || !isXdtMemoryBinding(prepared.binding)) return undefined;
  if (prepared.binding.provider !== 'xdt') return undefined;
  if (prepared.binding.canonicalWorkspaceId !== PRODUCTION_WRITE_WORKSPACE) return undefined;
  const repoRoot = input.repoRoot.trim();
  const dataRoot = input.dataRoot.trim();
  if (!repoRoot || !dataRoot) return undefined;

  const loadSettings = input.loadSettings ?? loadMemoryProviderSettings;
  const readTxn = input.readTxn ?? readTransaction;
  let settings;
  try {
    settings = await loadSettings(input.owner);
  } catch (err) {
    if (err instanceof XdtPrepareError) return undefined;
    throw err;
  }
  if (settings.status !== 'readable' || !settings.settings) return undefined;
  const txn = readTxn(input.owner);
  if (txn && txn.state !== 'committed') return undefined;

  return {
    repoRoot,
    dataRoot,
    workspace: PRODUCTION_WRITE_WORKSPACE,
  };
}
