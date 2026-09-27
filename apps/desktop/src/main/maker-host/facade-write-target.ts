/**
 * 前置刀 1c：写路径守卫。缺字段 / 生产树 / 禁 UUID 必须在 new MemoryStore 之前失败。
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveXdtMemoryRoot, UUID_V4_RE } from '@cindy/maker-core';

export const FORBIDDEN_WRITE_WORKSPACES = Object.freeze([
  'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
  '5fb84df7-8de0-4f74-a7ff-6c7b0850f317',
]);

export type FacadeWriteTargetErrorCode =
  | 'WRITE_TARGET_REQUIRED'
  | 'WRITE_TARGET_FORBIDDEN';

export class FacadeWriteTargetError extends Error {
  readonly code: FacadeWriteTargetErrorCode;

  constructor(code: FacadeWriteTargetErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FacadeWriteTargetError';
    this.code = code;
  }
}

export interface FacadeWriteTarget {
  repoRoot: string;
  dataRoot: string;
  workspace: string;
}

function realpathOrThrow(target: string, label: string): string {
  try {
    const native = (fs.realpathSync as typeof fs.realpathSync & { native?: typeof fs.realpathSync }).native;
    return native ? native(target) : fs.realpathSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      throw new FacadeWriteTargetError(
        'WRITE_TARGET_FORBIDDEN',
        `${label} realpath is not permitted`,
      );
    }
    throw new FacadeWriteTargetError('WRITE_TARGET_REQUIRED', `${label} is not a resolvable path`);
  }
}

function tryRealpath(target: string | undefined): string | undefined {
  if (!target) return undefined;
  try {
    const native = (fs.realpathSync as typeof fs.realpathSync & { native?: typeof fs.realpathSync }).native;
    return native ? native(target) : fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function assertWriteTarget(target: Partial<FacadeWriteTarget> | undefined): FacadeWriteTarget {
  if (!target) {
    throw new FacadeWriteTargetError('WRITE_TARGET_REQUIRED', 'write target is required');
  }
  const repoRoot = typeof target.repoRoot === 'string' ? target.repoRoot.trim() : '';
  const dataRoot = typeof target.dataRoot === 'string' ? target.dataRoot.trim() : '';
  const workspace = typeof target.workspace === 'string' ? target.workspace.trim() : '';
  if (!repoRoot || !dataRoot || !workspace) {
    throw new FacadeWriteTargetError(
      'WRITE_TARGET_REQUIRED',
      'repoRoot, dataRoot, and workspace must be Host-injected',
    );
  }
  if (!UUID_V4_RE.test(workspace)) {
    throw new FacadeWriteTargetError('WRITE_TARGET_FORBIDDEN', 'workspace must be UUID v4');
  }
  if (FORBIDDEN_WRITE_WORKSPACES.includes(workspace)) {
    throw new FacadeWriteTargetError('WRITE_TARGET_FORBIDDEN', 'workspace is a production or sandbox UUID');
  }

  const repoReal = realpathOrThrow(repoRoot, 'repoRoot');
  const dataReal = realpathOrThrow(dataRoot, 'dataRoot');
  const resolvedRepo = resolveXdtMemoryRoot();
  const productionRepos = [
    tryRealpath(resolvedRepo),
    tryRealpath(process.env.XDT_MEMORY_REPO),
    tryRealpath('D:/AI/Codex/xdt-memory'),
  ].filter((value): value is string => Boolean(value));
  if (productionRepos.some((candidate) => samePath(repoReal, candidate))) {
    throw new FacadeWriteTargetError('WRITE_TARGET_FORBIDDEN', 'repoRoot is the production xdt-memory checkout');
  }
  const productionDataTrees = [
    tryRealpath(process.env.XDT_MEMORY_HOME),
    tryRealpath(path.join(resolvedRepo, 'data')),
    tryRealpath('D:/AI/Codex/xdt-memory/data'),
  ].filter((value): value is string => Boolean(value));
  if (productionDataTrees.some((candidate) => samePath(dataReal, candidate))) {
    throw new FacadeWriteTargetError('WRITE_TARGET_FORBIDDEN', 'dataRoot is the production xdt-memory data tree');
  }
  const relative = path.relative(repoReal, dataReal);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FacadeWriteTargetError('WRITE_TARGET_FORBIDDEN', 'dataRoot must be inside repoRoot');
  }
  return { repoRoot: repoReal, dataRoot: dataReal, workspace };
}
