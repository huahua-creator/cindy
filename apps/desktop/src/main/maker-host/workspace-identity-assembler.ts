/**
 * 段 3 Host assembler：把当下 owner 拼成段 2 registry 需要的
 * `{ dataOwnerId, ownerRoot }`。路径公式与 maker-memory-host 相同。
 *
 * 有 UUID ≠ 启用 xdt ≠ prepareMemorySession。
 * 禁止调用 ownerScopedUserDataPath() 拼 registry（无 owner 会落到 cindy-no-session）。
 * 可读 dialogueWorkspaceRootDir() 只做前缀拒绝。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { XdtPrepareError } from '@cindy/maker-core';
import {
  isManagedWorktreeDirectoryName,
  managedWorktreeBaseRepo,
} from '@cindy/maker-shared/worktree-paths';

import { createIpcError } from '../../shared/ipc-errors.js';

import {
  LOCAL_DATA_OWNER_ID,
  dataOwnerStorageKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { dialogueWorkspaceRootDir } from '../localDb/dialogueWorkspace.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

export interface AssembledOwnerScope {
  dataOwnerId: string;
  ownerRoot: string;
}

export function resolveOwnerScopedRegistryRoot(): AssembledOwnerScope {
  if (isAppSessionBoundaryPending()) {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'app session boundary is pending; do not join registry path',
    );
  }
  const session = getActiveAppSession();
  const ownerId = session.dataOwnerId;
  if (!ownerId || session.mode === 'signed-out') {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'dataOwnerId is required before registry path join or mkdir',
    );
  }
  // local 模式 LOCAL_DATA_OWNER_ID 算已登录 owner，允许登记。
  if (session.mode === 'local' && ownerId !== LOCAL_DATA_OWNER_ID) {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'local mode must use LOCAL_DATA_OWNER_ID',
    );
  }
  return {
    dataOwnerId: ownerId,
    ownerRoot: path.join(app.getPath('userData'), 'owners', dataOwnerStorageKey(ownerId)),
  };
}

function slashNormalized(abs: string): string {
  return abs.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function isUncPath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//');
}

function rejectRemoteLocation(value: string, message: string): void {
  if (/^(ssh|sftp|cindy-remote):/i.test(value) || isUncPath(value)) {
    throw createIpcError('UNSUPPORTED_CAPABILITY', message);
  }
}

function isManagedWorktreeLocation(value: string): boolean {
  if (managedWorktreeBaseRepo(value)) return true;
  const segments = value.replaceAll('\\', '/').split('/').filter(Boolean);
  return segments.some((segment) => isManagedWorktreeDirectoryName(segment));
}

function isUnderPrefix(resolved: string, root: string): boolean {
  let rootResolved: string;
  try {
    rootResolved = fs.realpathSync.native(root);
  } catch {
    rootResolved = path.resolve(root);
  }
  const target = slashNormalized(resolved);
  const prefix = slashNormalized(rootResolved);
  return target === prefix || target.startsWith(`${prefix}/`);
}

export function assertEligibleLocalProjectDir(absDir: string): string {
  if (typeof absDir !== 'string' || absDir.trim() === '') {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'absDir is required');
  }
  const trimmed = absDir.trim();
  if (trimmed.includes('\0')) {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'absDir is invalid');
  }
  rejectRemoteLocation(trimmed, 'remote / SSH / UNC directories cannot be registered');
  if (!path.isAbsolute(trimmed) || trimmed === 'claude_obsidian_work') {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'absDir must be an absolute local directory');
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync.native(trimmed);
  } catch {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'local workspace directory is not ready');
  }
  rejectRemoteLocation(resolved, 'remote / SSH / UNC directories cannot be registered');
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'local workspace path is not a directory');
  }

  const stored = normalizeWorkingDirForStorage(resolved) ?? resolved.replaceAll('\\', '/');
  if (
    isManagedWorktreeLocation(stored)
    || isManagedWorktreeLocation(resolved)
    || isManagedWorktreeDirectoryName(path.basename(resolved))
  ) {
    throw createIpcError(
      'UNSUPPORTED_CAPABILITY',
      'Cindy-managed worktree directories cannot be registered',
    );
  }
  if (isUnderPrefix(resolved, dialogueWorkspaceRootDir())) {
    throw createIpcError(
      'UNSUPPORTED_CAPABILITY',
      'dialogue workspaces cannot be registered',
    );
  }
  return resolved;
}
