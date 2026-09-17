/**
 * 段 4：createSession 只读 attach 已确认 UUID。
 *
 * import 面只有 lookup / readRegistry / assembler，禁止 minting aliases.
 * 禁止给 preparedMemorySession / memoryBinding / memoryProviderRequested 赋值。
 * 未登记 / 不合格 / 无 owner / remote / dialogue / worktree 跳过，不阻断创建。
 * 坏 registry CONFIG_INVALID 必须冒泡中止创建。
 */

import type { CreateSessionOptions } from '@cindy/maker-core';
import { XdtPrepareError } from '@cindy/maker-core';

import { isIpcError } from '../../shared/ipc-errors.js';
import {
  assertEligibleLocalProjectDir,
  resolveOwnerScopedRegistryRoot,
  type AssembledOwnerScope,
} from './workspace-identity-assembler.js';
import {
  lookupLocalAlias,
  readRegistry,
  type RegistryReadResult,
} from './workspace-identity-registry.js';
import {
  forgetSessionWorkspaceIdentity,
  rememberSessionWorkspaceIdentity,
} from './session-workspace-identity.js';

export interface AttachSessionWorkspaceIdentityDeps {
  assertEligibleDir: (absDir: string) => string;
  resolveOwner: () => AssembledOwnerScope;
  read: (scope: AssembledOwnerScope) => RegistryReadResult;
  lookup: typeof lookupLocalAlias;
  remember: typeof rememberSessionWorkspaceIdentity;
  forget: typeof forgetSessionWorkspaceIdentity;
}

const defaultDeps: AttachSessionWorkspaceIdentityDeps = {
  assertEligibleDir: assertEligibleLocalProjectDir,
  resolveOwner: resolveOwnerScopedRegistryRoot,
  read: readRegistry,
  lookup: lookupLocalAlias,
  remember: rememberSessionWorkspaceIdentity,
  forget: forgetSessionWorkspaceIdentity,
};

function isConfigInvalid(err: unknown): boolean {
  if (err instanceof XdtPrepareError && err.code === 'CONFIG_INVALID') return true;
  return isIpcError(err) && err.code === 'CONFIG_INVALID';
}

export async function attachSessionWorkspaceIdentity(
  sessionId: string,
  opts: CreateSessionOptions,
  overrides: Partial<AttachSessionWorkspaceIdentityDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  if (opts.preparedMemorySession) return;
  deps.forget(sessionId);
  if (opts.remoteHostId) return;
  if (!opts.workingDir) return;

  let resolved: string;
  try {
    resolved = deps.assertEligibleDir(opts.workingDir);
  } catch (err) {
    if (isConfigInvalid(err)) throw err;
    return;
  }

  let owner: AssembledOwnerScope;
  try {
    owner = deps.resolveOwner();
  } catch (err) {
    if (isConfigInvalid(err)) throw err;
    return;
  }

  let read: RegistryReadResult;
  try {
    read = deps.read(owner);
  } catch (err) {
    if (isConfigInvalid(err)) throw err;
    return;
  }
  if (read.status === 'unreadable') {
    throw new XdtPrepareError('CONFIG_INVALID', 'workspace identity registry is unreadable');
  }
  if (read.status === 'missing') return;

  try {
    const found = await deps.lookup({ ...owner, absDir: resolved });
    deps.remember(sessionId, {
      canonicalWorkspaceId: found.canonicalWorkspaceId,
      locatorDigest: found.locatorDigest,
    });
  } catch (err) {
    if (isConfigInvalid(err)) throw err;
  }
}
