/**
 * 前置刀 1b：durable retry 账本。
 * 路径 = ownerRoot/facade-invocation-ledger/<callIdentityDigest>.json
 * 不进 facade-journal/<digest>/，不计入 1a directoryBytes。
 * 与 journal 共用 facade-journal.lock，但不得嵌套 claimFacadeInvocation。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HEX64_RE } from '@cindy/maker-core';

import { objectDigest } from './facade-canonical.js';
import {
  ownerScopeDigest,
  withFacadeJournalLock,
} from './facade-journal.js';
import type { RegistryOwnerScope } from './workspace-identity-registry.js';

export const FACADE_INVOCATION_LEDGER_DIR = 'facade-invocation-ledger';
export const FACADE_CALL_INDEX_DIR = 'facade-call-index';

export type FacadeInvocationLedgerErrorCode =
  | 'MUTATION_IDENTITY_UNAVAILABLE'
  | 'JOURNAL_BUSY'
  | 'WORKSPACE_IDENTITY_REQUIRED';

export class FacadeInvocationLedgerError extends Error {
  readonly code: FacadeInvocationLedgerErrorCode;

  constructor(code: FacadeInvocationLedgerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FacadeInvocationLedgerError';
    this.code = code;
  }
}

export interface FacadeInvocationLedgerV1 {
  schemaVersion: 1;
  threadId: string;
  turnId: string;
  callId: string;
  invocationId: string;
  innerToolName: 'memory_write' | 'memory_delete' | 'memory_consolidate';
  normalizedArgsDigest: string;
  sessionInstanceId: string;
  preparedMemorySessionId: string;
  ownerScopeDigest: string;
  issuedAt: string;
  facadeOperationId: string | null;
  operationId: string | null;
  expectedRevision: string | null;
}

export interface CallIdentity {
  threadId: string;
  turnId: string;
  callId: string;
}

export function callIdentityDigest(identity: CallIdentity): string {
  return objectDigest({
    threadId: identity.threadId,
    turnId: identity.turnId,
    callId: identity.callId,
  });
}

export function invocationLedgerRoot(scope: RegistryOwnerScope): string {
  if (!scope.dataOwnerId || !scope.ownerRoot) {
    throw new FacadeInvocationLedgerError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'owner scope is required before ledger path join',
    );
  }
  return path.join(scope.ownerRoot, FACADE_INVOCATION_LEDGER_DIR, ownerScopeDigest(scope.dataOwnerId));
}

export function ledgerPath(scope: RegistryOwnerScope, digest: string): string {
  if (!HEX64_RE.test(digest)) {
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'callIdentityDigest must be sha256 hex');
  }
  return path.join(invocationLedgerRoot(scope), `${digest}.json`);
}

export function callIndexRoot(scope: RegistryOwnerScope): string {
  if (!scope.dataOwnerId || !scope.ownerRoot) {
    throw new FacadeInvocationLedgerError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'owner scope is required before ledger path join',
    );
  }
  return path.join(scope.ownerRoot, FACADE_CALL_INDEX_DIR, ownerScopeDigest(scope.dataOwnerId));
}

export function callIndexPath(scope: RegistryOwnerScope, digest: string): string {
  if (!HEX64_RE.test(digest)) {
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'callIdentityDigest must be sha256 hex');
  }
  return path.join(callIndexRoot(scope), `${digest}.json`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`.replace(/\r/g, '');
}

function isReparsePath(target: string, stat: fs.Stats): boolean {
  if (stat.isSymbolicLink()) return true;
  const reparseTag = Number((stat as fs.Stats & { reparseTag?: number }).reparseTag);
  if (Number.isFinite(reparseTag) && reparseTag !== 0) return true;
  if (process.platform !== 'win32') return false;
  try {
    fs.readlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

async function mkdirReal(target: string): Promise<void> {
  const parent = path.dirname(target);
  if (parent !== target) await mkdirReal(parent);
  try {
    const existing = await fsp.lstat(target);
    if (isReparsePath(target, existing)) {
      throw new FacadeInvocationLedgerError(
        'MUTATION_IDENTITY_UNAVAILABLE',
        `${target} must not be a symlink, junction, or reparse point`,
      );
    }
    if (!existing.isDirectory()) {
      throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', `${target} is not a directory`);
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof FacadeInvocationLedgerError) throw err;
      throw err;
    }
  }
  try {
    await fsp.mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

async function writeUtf8Atomic(filePath: string, utf8: string): Promise<void> {
  await mkdirReal(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fsp.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(utf8, 'utf8');
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await handle.close();
  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function parseLedger(utf8: string, expectedDigest: string): FacadeInvocationLedgerV1 {
  if (utf8.includes('\r')) {
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'ledger CR forbidden');
  }
  let parsed: FacadeInvocationLedgerV1;
  try {
    parsed = JSON.parse(utf8) as FacadeInvocationLedgerV1;
  } catch {
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'ledger is not json');
  }
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.invocationId) {
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'ledger shape invalid');
  }
  const recomputed = callIdentityDigest({
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    callId: parsed.callId,
  });
  if (recomputed !== expectedDigest) {
    throw new FacadeInvocationLedgerError(
      'MUTATION_IDENTITY_UNAVAILABLE',
      'ledger filename digest does not match fields',
    );
  }
  if (parsed.expectedRevision === undefined) {
    parsed.expectedRevision = null;
  }
  return parsed;
}

async function readIndexInvocationId(
  scope: RegistryOwnerScope,
  digest: string,
): Promise<string | undefined> {
  const filePath = callIndexPath(scope, digest);
  try {
    const stat = await fsp.lstat(filePath);
    if (isReparsePath(filePath, stat)) {
      throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'call index is a reparse point');
    }
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as { invocationId?: string };
    if (typeof parsed.invocationId !== 'string' || !parsed.invocationId) {
      throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'call index is unreadable');
    }
    return parsed.invocationId;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (err instanceof FacadeInvocationLedgerError) throw err;
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'call index is unreadable');
  }
}

export async function readCallIndexInvocationId(
  owner: RegistryOwnerScope,
  identity: CallIdentity,
): Promise<string | undefined> {
  const digest = callIdentityDigest(identity);
  try {
    return await withFacadeJournalLock(owner, () => readIndexInvocationId(owner, digest));
  } catch (err) {
    if (err instanceof FacadeInvocationLedgerError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('JOURNAL_BUSY') || message.includes('busy')) {
      throw new FacadeInvocationLedgerError('JOURNAL_BUSY', 'facade journal is busy');
    }
    throw err;
  }
}

async function readLedgerFile(
  scope: RegistryOwnerScope,
  digest: string,
): Promise<FacadeInvocationLedgerV1 | undefined> {
  const filePath = ledgerPath(scope, digest);
  try {
    const stat = await fsp.lstat(filePath);
    if (isReparsePath(filePath, stat)) {
      throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'ledger is a reparse point');
    }
    const utf8 = await fsp.readFile(filePath, 'utf8');
    return parseLedger(utf8, digest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (err instanceof FacadeInvocationLedgerError) throw err;
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'ledger is unreadable');
  }
}

export async function readInvocationLedger(
  owner: RegistryOwnerScope,
  identity: CallIdentity,
): Promise<FacadeInvocationLedgerV1 | undefined> {
  const digest = callIdentityDigest(identity);
  try {
    return await withFacadeJournalLock(owner, () => readLedgerFile(owner, digest));
  } catch (err) {
    if (err instanceof FacadeInvocationLedgerError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('JOURNAL_BUSY') || message.includes('busy')) {
      throw new FacadeInvocationLedgerError('JOURNAL_BUSY', 'facade journal is busy');
    }
    throw err;
  }
}

export async function writeIdentityLedger(
  owner: RegistryOwnerScope,
  record: FacadeInvocationLedgerV1,
): Promise<FacadeInvocationLedgerV1> {
  const digest = callIdentityDigest(record);
  const filePath = ledgerPath(owner, digest);
  try {
    return await withFacadeJournalLock(owner, async () => {
      const existing = await readLedgerFile(owner, digest);
      if (existing) {
        if (existing.invocationId !== record.invocationId) {
          throw new FacadeInvocationLedgerError(
            'MUTATION_IDENTITY_UNAVAILABLE',
            'identity ledger already exists; do not remint',
          );
        }
        return existing;
      }
      await writeUtf8Atomic(filePath, serialize(record));
      await writeUtf8Atomic(callIndexPath(owner, digest), serialize({
        schemaVersion: 1,
        invocationId: record.invocationId,
      }));
      return record;
    });
  } catch (err) {
    if (err instanceof FacadeInvocationLedgerError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('JOURNAL_BUSY') || message.includes('busy')) {
      throw new FacadeInvocationLedgerError('JOURNAL_BUSY', 'facade journal is busy');
    }
    throw err;
  }
}

export async function fillInvocationLedgerOperationIds(
  owner: RegistryOwnerScope,
  identity: CallIdentity,
  ids: { facadeOperationId: string; operationId: string },
): Promise<FacadeInvocationLedgerV1> {
  const digest = callIdentityDigest(identity);
  const filePath = ledgerPath(owner, digest);
  try {
    return await withFacadeJournalLock(owner, async () => {
      const existing = await readLedgerFile(owner, digest);
      if (!existing) {
        throw new FacadeInvocationLedgerError(
          'MUTATION_IDENTITY_UNAVAILABLE',
          'identity ledger missing before operation-id fill',
        );
      }
      if (existing.facadeOperationId && existing.operationId) {
        if (
          existing.facadeOperationId !== ids.facadeOperationId
          || existing.operationId !== ids.operationId
        ) {
          throw new FacadeInvocationLedgerError(
            'MUTATION_IDENTITY_UNAVAILABLE',
            'ledger operation ids do not match claim',
          );
        }
        return existing;
      }
      const next: FacadeInvocationLedgerV1 = {
        ...existing,
        facadeOperationId: ids.facadeOperationId,
        operationId: ids.operationId,
      };
      await writeUtf8Atomic(filePath, serialize(next));
      return next;
    });
  } catch (err) {
    if (err instanceof FacadeInvocationLedgerError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('JOURNAL_BUSY') || message.includes('busy')) {
      throw new FacadeInvocationLedgerError('JOURNAL_BUSY', 'facade journal is busy');
    }
    throw err;
  }
}
