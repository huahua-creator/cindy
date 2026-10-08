/**
 * 段 3 workspace identity IPC 业务体。
 *
 * lookup/create 只收 renderer 路径字符串。Host 才是 absDir 权威。
 * 有 UUID ≠ 启用 xdt ≠ prepareMemorySession。
 * ipcMain adapter 在 register.ts；本文件可注入依赖免 Electron 直测。
 */

import { XdtPrepareError } from '@cindy/maker-core';

import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import {
  assertEligibleLocalProjectDir,
  resolveOwnerScopedRegistryRoot,
  type AssembledOwnerScope,
} from '../maker-host/workspace-identity-assembler.js';
import {
  createLocalAlias,
  lookupLocalAlias,
  readRegistry,
} from '../maker-host/workspace-identity-registry.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface WorkspaceIdentityLookupResult {
  status: 'missing' | 'bound';
  canonicalWorkspaceId?: string;
  locatorDigest?: string;
}

export interface WorkspaceIdentityCreateResult {
  status: 'bound';
  canonicalWorkspaceId: string;
  locatorDigest: string;
  created: boolean;
}

export interface WorkspaceIdentityIpcDeps {
  assertTrustedSender: (event: unknown) => void;
  resolveOwner: () => AssembledOwnerScope;
  assertEligibleDir: (absDir: string) => string;
  lookup: typeof lookupLocalAlias;
  create: typeof createLocalAlias;
  read: typeof readRegistry;
}

const FORBIDDEN_RENDERER_IDENTITY_KEYS = [
  'dataOwnerId',
  'ownerRoot',
  'canonicalWorkspaceId',
  'locatorDigest',
  'uuid',
] as const;

function mapPrepareError(err: unknown): never {
  if (err instanceof XdtPrepareError) {
    const allowed: readonly IpcErrorCode[] = [
      'WORKSPACE_IDENTITY_REQUIRED',
      'WORKSPACE_IDENTITY_CONFLICT',
      'CONFIG_INVALID',
      'MAKER_MEMORY_NOT_READY',
    ];
    if (!allowed.includes(err.code as IpcErrorCode)) {
      throwIpcError('INTERNAL', err.message.replace(/^[A-Z0-9_]+:\s*/, ''));
    }
    throwIpcError(err.code as IpcErrorCode, err.message.replace(/^[A-Z0-9_]+:\s*/, ''));
  }
  throw err;
}

function requireAbsDirPayload(body: unknown): { absDir: string; extra: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throwIpcError('INVALID_PARAMS', 'payload must be an object');
  }
  const extra = { ...(body as Record<string, unknown>) };
  const absDir = extra.absDir;
  delete extra.absDir;
  if (typeof absDir !== 'string') {
    throwIpcError('INVALID_PARAMS', 'absDir is required');
  }
  for (const key of FORBIDDEN_RENDERER_IDENTITY_KEYS) {
    if (key in extra) {
      throwIpcError('INVALID_PARAMS', `renderer must not pass ${key}`);
    }
  }
  return { absDir, extra };
}

export function createWorkspaceIdentityIpc(
  overrides: Partial<WorkspaceIdentityIpcDeps> = {},
) {
  const deps: WorkspaceIdentityIpcDeps = {
    assertTrustedSender: (event) => {
      void event;
      throwIpcError('INTERNAL', 'assertTrustedSender not wired');
    },
    resolveOwner: resolveOwnerScopedRegistryRoot,
    assertEligibleDir: assertEligibleLocalProjectDir,
    lookup: lookupLocalAlias,
    create: createLocalAlias,
    read: readRegistry,
    ...overrides,
  };
  const lookupHandler = async (event: unknown, body: unknown): Promise<WorkspaceIdentityLookupResult> => {
    deps.assertTrustedSender(event);
    const { absDir, extra } = requireAbsDirPayload(body);
    if (Object.keys(extra).length > 0) {
      throwIpcError('INVALID_PARAMS', `unexpected fields: ${Object.keys(extra).join(',')}`);
    }
    try {
      const resolved = deps.assertEligibleDir(absDir);
      const owner = deps.resolveOwner();
      const read = deps.read(owner);
      if (read.status === 'unreadable') {
        throwIpcError('CONFIG_INVALID', 'workspace identity registry is unreadable');
      }
      if (read.status === 'missing') {
        return { status: 'missing' };
      }
      try {
        const found = await deps.lookup({ ...owner, absDir: resolved });
        return {
          status: 'bound',
          canonicalWorkspaceId: found.canonicalWorkspaceId,
          locatorDigest: found.locatorDigest,
        };
      } catch (err) {
        if (err instanceof XdtPrepareError && err.code === 'MAKER_MEMORY_NOT_READY') {
          return { status: 'missing' };
        }
        mapPrepareError(err);
      }
    } catch (err) {
      if (err instanceof XdtPrepareError) mapPrepareError(err);
      throw err;
    }
  };

  const createHandler = async (event: unknown, body: unknown): Promise<WorkspaceIdentityCreateResult> => {
    deps.assertTrustedSender(event);
    const { absDir, extra } = requireAbsDirPayload(body);
    const confirmed = extra.confirmed;
    delete extra.confirmed;
    if (Object.keys(extra).length > 0) {
      throwIpcError('INVALID_PARAMS', `unexpected fields: ${Object.keys(extra).join(',')}`);
    }
    if (confirmed !== true) {
      throwIpcError('WORKSPACE_IDENTITY_REQUIRED', 'create requires confirmed === true');
    }
    try {
      const resolved = deps.assertEligibleDir(absDir);
      const owner = deps.resolveOwner();
      const created = await deps.create({
        ...owner,
        absDir: resolved,
        confirmed: true,
      });
      return {
        status: 'bound',
        canonicalWorkspaceId: created.canonicalWorkspaceId,
        locatorDigest: created.locatorDigest,
        created: created.created,
      };
    } catch (err) {
      if (err instanceof XdtPrepareError) mapPrepareError(err);
      throw err;
    }
  };

  return {
    lookup: lookupHandler,
    create: createHandler,
  };
}
