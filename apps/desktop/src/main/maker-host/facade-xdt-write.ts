/**
 * 前置刀 1c：隔离树上的 Host facade memory_write。
 * 不改 write.ts:55，不给 frozen store 开写。
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import { resolveXdtMemoryRoot, UUID_V4_RE } from '@cindy/maker-core';

import {
  assertWriteTarget,
  FacadeWriteTargetError,
  type FacadeWriteTarget,
} from './facade-write-target.js';

export class FacadeWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FacadeWriteError';
    this.code = code;
  }
}

export interface FacadeWriteArgs {
  type: 'user' | 'feedback' | 'project' | 'reference';
  name: string;
  title: string;
  description: string;
  body: string;
  mode: 'create' | 'update';
}

export interface FacadeWriteStore {
  get(key: string): Promise<{ revision?: string | null } | null>;
  upsert(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type CreateFacadeWriteStore = (options: Record<string, unknown>) => FacadeWriteStore;

const require = createRequire(import.meta.url);

function loadMemoryStoreCtor(): new (options: Record<string, unknown>) => FacadeWriteStore {
  const storePath = path.join(resolveXdtMemoryRoot(), 'src/memory-store.mjs');
  const mod = require(storePath) as { MemoryStore: new (options: Record<string, unknown>) => FacadeWriteStore };
  return mod.MemoryStore;
}

function defaultCreateStore(): CreateFacadeWriteStore {
  const MemoryStore = loadMemoryStoreCtor();
  return (options) => new MemoryStore(options);
}

export function freezeExpectedRevision(input: {
  target: FacadeWriteTarget;
  name: string;
  createStore?: CreateFacadeWriteStore;
  allowProductionWorkspace?: boolean;
  allowProductionTree?: boolean;
}): Promise<string | null> {
  const target = assertWriteTarget(input.target, {
    allowProductionWorkspace: input.allowProductionWorkspace,
    allowProductionTree: input.allowProductionTree,
  });
  const createStore = input.createStore ?? defaultCreateStore();
  const store = createStore({
    repoRoot: target.repoRoot,
    dataRoot: target.dataRoot,
    workspace: target.workspace,
    mutationMode: 'disabled',
    legacyMode: 'disabled',
    extraReadWorkspaces: [],
    device: 'cindy-host-facade-read',
  });
  return store.get(input.name).then((record) => {
    const revision = record?.revision;
    return typeof revision === 'string' && revision.length > 0 ? revision : null;
  });
}

export async function upsertFacadeMemoryWrite(input: {
  target: FacadeWriteTarget;
  args: FacadeWriteArgs;
  operationId: string;
  expectedRevision: string | null;
  createStore?: CreateFacadeWriteStore;
  allowProductionWorkspace?: boolean;
  allowProductionTree?: boolean;
}): Promise<Record<string, unknown>> {
  const target = assertWriteTarget(input.target, {
    allowProductionWorkspace: input.allowProductionWorkspace,
    allowProductionTree: input.allowProductionTree,
  });
  if (!UUID_V4_RE.test(input.operationId)) {
    throw new FacadeWriteError('INVALID_ARGS', 'operationId must be UUID v4 from the claim ledger');
  }
  if (input.args.mode === 'create' && input.expectedRevision !== null) {
    throw new FacadeWriteError('INVALID_ARGS', 'create must freeze expected_revision null');
  }
  if (input.args.mode === 'update' && (typeof input.expectedRevision !== 'string' || !input.expectedRevision)) {
    throw new FacadeWriteError('INVALID_ARGS', 'update requires a frozen expected_revision');
  }
  const createStore = input.createStore ?? defaultCreateStore();
  const store = createStore({
    repoRoot: target.repoRoot,
    dataRoot: target.dataRoot,
    workspace: target.workspace,
    mutationMode: 'strict_shared',
    extraReadWorkspaces: [],
    legacyMode: 'disabled',
    device: 'cindy-host-facade-write',
  });
  try {
    const result = await store.upsert({
      operation_id: input.operationId,
      expected_revision: input.expectedRevision,
      id: input.args.name,
      title: input.args.title,
      content: input.args.body,
      kind: input.args.type,
      scope: 'workspace',
      source_harness: 'cindy',
    });
    if (result?.shared !== true) {
      throw new FacadeWriteError('WRITE_NOT_SHARED', 'facade write did not verify shared:true');
    }
    return result;
  } catch (err) {
    if (err instanceof FacadeWriteError || err instanceof FacadeWriteTargetError) throw err;
    const code = (err as { code?: string }).code ?? 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    throw new FacadeWriteError(code, message);
  }
}
