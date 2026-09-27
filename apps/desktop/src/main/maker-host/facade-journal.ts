/**
 * 前置刀 1a：owner-scoped facade journal 文件层。
 *
 * journal 根 = 注入的 ownerRoot/facade-journal/，与 workspace-identity-registry 同级。
 * 测试必须显式注入 temp ownerRoot；禁止默认扫生产 Roaming。
 * 不接线 cindy_memory write，不切 defaultProvider。
 *
 * xdt-memory 尚未发布 facade-journal-intent / capability schema（本机 origin/main
 * 只有 facade-operation-v1）。本刀消费 loadXdtSchemaValidator 同一根上的
 * canonical-json digest，对象形状走注入的 FixtureJournalValidator，不把私有
 * schema 复制进 Cindy。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  HEX64_RE,
  UUID_V4_RE,
  resolveXdtMemoryRoot,
} from '@cindy/maker-core';

import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import type { RegistryOwnerScope } from './workspace-identity-registry.js';

const require = createRequire(import.meta.url);

export const FACADE_JOURNAL_DIR = 'facade-journal';
const INTENT_FILE = 'intent.json';
const LOCK_FILE = 'facade-journal.lock';
const CLAIMS_DIR = 'claims';
const GC_QUARANTINE_DIR = 'gc-quarantine';
const OWNER_SCOPE_PREFIX = 'owner-scope-v1:';

export type FacadeJournalErrorCode =
  | 'JOURNAL_INVALID'
  | 'JOURNAL_CAPACITY_EXCEEDED'
  | 'JOURNAL_BUSY'
  | 'FACADE_CAPABILITY_REQUIRED'
  | 'WORKSPACE_IDENTITY_REQUIRED';

export class FacadeJournalError extends Error {
  readonly code: FacadeJournalErrorCode;

  constructor(code: FacadeJournalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FacadeJournalError';
    this.code = code;
  }
}

export type FacadeJournalIntentState =
  | 'prepared'
  | 'claim_published'
  | 'entry_published'
  | 'committed';

export interface FacadeJournalIntentV1 {
  schemaVersion: 1;
  intentId: string;
  invocationIdDigest: string;
  facadeOperationId: string;
  expectedClaimDigest: string | null;
  expectedEntryDigest: string | null;
  intendedClaimDigest: string;
  intendedEntryDigest: string;
  state: FacadeJournalIntentState;
}

export interface FacadeJournalClaimV1 {
  schemaVersion: 1;
  invocationId: string;
  invocationIdDigest: string;
  facadeOperationId: string;
  operationId: string;
}

export interface FacadeJournalEntryStubV1 {
  schemaVersion: 1;
  facadeOperationId: string;
  invocationId: string;
  operationId: string;
  state: 'claimed';
}

export interface FacadeInitialCapabilityFixture {
  kind: 'FacadeInitialInvocationCapabilityV1';
  invocationId: string;
}

export interface FixtureJournalValidator {
  validateIntent(utf8: string): { ok: boolean; code?: string; message?: string };
  validateClaim(utf8: string): { ok: boolean; code?: string; message?: string };
  validateEntry(utf8: string): { ok: boolean; code?: string; message?: string };
}

export interface FacadeJournalLimits {
  maxOwnerBytes: number;
}

export interface FacadeJournalDeps {
  owner: RegistryOwnerScope;
  validator: FixtureJournalValidator;
  limits?: FacadeJournalLimits;
  randomUuid?: () => string;
}

export interface ClaimResult {
  facadeOperationId: string;
  operationId: string;
  invocationIdDigest: string;
  claimPath: string;
  entryPath: string;
}

const DEFAULT_LIMITS: FacadeJournalLimits = {
  maxOwnerBytes: 8 * 1024 * 1024,
};

const INTENT_STATES: readonly FacadeJournalIntentState[] = [
  'prepared',
  'claim_published',
  'entry_published',
  'committed',
];

function loadCanonicalDigest(): (utf8: string) => string {
  const root = resolveXdtMemoryRoot();
  const mod = require(path.join(root, 'src/schema-validator/canonical-json.mjs')) as {
    sha256Hex: (utf8: string) => string;
  };
  return mod.sha256Hex;
}

function sha256Utf8(utf8: string): string {
  const digest = loadCanonicalDigest()(utf8);
  if (!HEX64_RE.test(digest)) {
    throw new FacadeJournalError('JOURNAL_INVALID', 'digest must be sha256 hex');
  }
  return digest;
}

export function ownerScopeDigest(dataOwnerId: string): string {
  if (!dataOwnerId) {
    throw new FacadeJournalError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'dataOwnerId is required before journal path join or mkdir',
    );
  }
  return sha256Utf8(`${OWNER_SCOPE_PREFIX}${dataOwnerId}`);
}

export function shardForFacadeOperationId(facadeOperationId: string): string {
  const digest = createHash('sha256').update(facadeOperationId, 'utf8').digest();
  return String(digest[0]);
}

export function invocationIdDigest(invocationId: string): string {
  return sha256Utf8(invocationId);
}

function assertOwnerScope(scope: RegistryOwnerScope): void {
  if (!scope.dataOwnerId) {
    throw new FacadeJournalError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'dataOwnerId is required before journal path join or mkdir',
    );
  }
  if (!scope.ownerRoot) {
    throw new FacadeJournalError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'ownerRoot is required; do not call ownerScopedUserDataPath() from this module',
    );
  }
  const normalized = path.resolve(scope.ownerRoot);
  if (normalized.toLowerCase().includes('cindy-no-session')) {
    throw new FacadeJournalError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'journal must not write cindy-no-session',
    );
  }
  if (/appdata[/\\]roaming[/\\]cindy([/\\]|$)/i.test(normalized.replaceAll('\\', '/'))) {
    throw new FacadeJournalError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'journal ownerRoot must be injected; production Roaming is forbidden',
    );
  }
}

export function journalRoot(scope: RegistryOwnerScope): string {
  assertOwnerScope(scope);
  return path.join(scope.ownerRoot, FACADE_JOURNAL_DIR);
}

export function ownerJournalDir(scope: RegistryOwnerScope): string {
  return path.join(journalRoot(scope), ownerScopeDigest(scope.dataOwnerId));
}

function intentPath(scope: RegistryOwnerScope): string {
  return path.join(ownerJournalDir(scope), INTENT_FILE);
}

function lockPath(scope: RegistryOwnerScope): string {
  return path.join(ownerJournalDir(scope), LOCK_FILE);
}

export function claimPath(scope: RegistryOwnerScope, invocationDigest: string): string {
  return path.join(ownerJournalDir(scope), CLAIMS_DIR, `${invocationDigest}.json`);
}

export function entryPath(scope: RegistryOwnerScope, facadeOperationId: string): string {
  return path.join(
    ownerJournalDir(scope),
    shardForFacadeOperationId(facadeOperationId),
    `${facadeOperationId}.json`,
  );
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`.replace(/\r/g, '');
}

function objectDigest(value: unknown): string {
  const utf8 = serialize(value);
  return sha256Utf8(utf8.endsWith('\n') ? utf8.slice(0, -1) : utf8);
}

function isReparse(stat: fs.Stats): boolean {
  return stat.isSymbolicLink();
}

async function lstatNoFollow(target: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function assertNotReparse(target: string, label: string): Promise<void> {
  const stat = await lstatNoFollow(target);
  if (!stat) return;
  if (isReparse(stat)) {
    throw new FacadeJournalError('JOURNAL_INVALID', `${label} must not be a symlink, junction, or reparse point`);
  }
}

async function assertSafeDirectory(target: string, label: string): Promise<void> {
  const stat = await lstatNoFollow(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new FacadeJournalError('JOURNAL_INVALID', `${label} must not be a symlink, junction, or reparse point`);
  }
  if (!stat.isDirectory()) {
    throw new FacadeJournalError('JOURNAL_INVALID', `${label} is not a directory`);
  }
}

async function mkdirReal(target: string): Promise<void> {
  const parent = path.dirname(target);
  if (parent !== target) await mkdirReal(parent);
  await assertSafeDirectory(target, target);
  const existing = await lstatNoFollow(target);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new FacadeJournalError('JOURNAL_INVALID', `${target} must not be a symlink, junction, or reparse point`);
    }
    return;
  }
  try {
    await fsp.mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  await assertSafeDirectory(target, target);
}

async function syncFile(handle: fsp.FileHandle): Promise<void> {
  await handle.sync();
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await fsp.open(dir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeUtf8Atomic(filePath: string, utf8: string): Promise<void> {
  await mkdirReal(path.dirname(filePath));
  await assertNotReparse(filePath, filePath);
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fsp.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(utf8, 'utf8');
    await syncFile(handle);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await handle.close();
  try {
    await fsp.rename(tmp, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function readUtf8(filePath: string): Promise<{ status: 'missing' | 'readable' | 'unreadable'; utf8?: string }> {
  try {
    const stat = await fsp.lstat(filePath);
    if (stat.isSymbolicLink()) {
      return { status: 'unreadable' };
    }
    const utf8 = await fsp.readFile(filePath, 'utf8');
    return { status: 'readable', utf8 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable' };
  }
}

function parseIntent(utf8: string, validator: FixtureJournalValidator): FacadeJournalIntentV1 {
  const result = validator.validateIntent(utf8);
  if (!result.ok) {
    throw new FacadeJournalError(
      'JOURNAL_INVALID',
      `facade journal intent schema rejected: ${result.code ?? result.message ?? 'invalid'}`,
    );
  }
  const parsed = JSON.parse(utf8) as FacadeJournalIntentV1;
  if (parsed.schemaVersion !== 1 || !INTENT_STATES.includes(parsed.state)) {
    throw new FacadeJournalError('JOURNAL_INVALID', 'facade journal intent is unreadable');
  }
  return parsed;
}

function parseClaim(utf8: string, validator: FixtureJournalValidator): FacadeJournalClaimV1 {
  const result = validator.validateClaim(utf8);
  if (!result.ok) {
    throw new FacadeJournalError(
      'JOURNAL_INVALID',
      `facade journal claim schema rejected: ${result.code ?? result.message ?? 'invalid'}`,
    );
  }
  return JSON.parse(utf8) as FacadeJournalClaimV1;
}

function parseEntry(utf8: string, validator: FixtureJournalValidator): FacadeJournalEntryStubV1 {
  const result = validator.validateEntry(utf8);
  if (!result.ok) {
    throw new FacadeJournalError(
      'JOURNAL_INVALID',
      `facade journal entry schema rejected: ${result.code ?? result.message ?? 'invalid'}`,
    );
  }
  return JSON.parse(utf8) as FacadeJournalEntryStubV1;
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new FacadeJournalError('JOURNAL_INVALID', `${full} must not be a symlink, junction, or reparse point`);
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) {
        const stat = await fsp.lstat(full);
        total += stat.size;
      }
    }
  };
  await walk(root);
  return total;
}

async function assertCapacity(scope: RegistryOwnerScope, limits: FacadeJournalLimits, extraBytes: number): Promise<void> {
  const used = await directoryBytes(ownerJournalDir(scope));
  if (used + extraBytes > limits.maxOwnerBytes) {
    throw new FacadeJournalError(
      'JOURNAL_CAPACITY_EXCEEDED',
      'owner journal capacity exceeded; uncommitted intents are not deleted',
    );
  }
}

function mintId(randomUuid: () => string, label: string): string {
  const id = randomUuid();
  if (!UUID_V4_RE.test(id)) {
    throw new FacadeJournalError('JOURNAL_INVALID', `${label} must be UUID v4`);
  }
  return id;
}

async function withOwnerJournalLock<T>(scope: RegistryOwnerScope, task: () => Promise<T>): Promise<T> {
  assertOwnerScope(scope);
  await mkdirReal(ownerJournalDir(scope));
  return withCrossProcessLock(
    lockPath(scope),
    { label: 'facade-journal', waitMs: 12_000 },
    async (status) => {
      if (!status.held) {
        throw new FacadeJournalError('JOURNAL_BUSY', 'facade journal is busy');
      }
      return task();
    },
  );
}

async function isolateInvalid(scope: RegistryOwnerScope, filePath: string): Promise<void> {
  const quarantineRoot = path.join(ownerJournalDir(scope), GC_QUARANTINE_DIR, randomUUID());
  await mkdirReal(quarantineRoot);
  const dest = path.join(quarantineRoot, path.basename(filePath));
  try {
    await fsp.rename(filePath, dest);
  } catch {
    // Isolation is best-effort; caller still fail-closes without overwriting.
  }
}

async function readIntentFile(
  scope: RegistryOwnerScope,
  validator: FixtureJournalValidator,
): Promise<FacadeJournalIntentV1 | undefined> {
  const filePath = intentPath(scope);
  const raw = await readUtf8(filePath);
  if (raw.status === 'missing') return undefined;
  if (raw.status === 'unreadable' || raw.utf8 === undefined) {
    await isolateInvalid(scope, filePath);
    throw new FacadeJournalError('JOURNAL_INVALID', 'facade journal intent is unreadable');
  }
  try {
    return parseIntent(raw.utf8, validator);
  } catch (err) {
    if (err instanceof FacadeJournalError && err.code === 'JOURNAL_INVALID') {
      await isolateInvalid(scope, filePath);
    }
    throw err;
  }
}

function digestMatches(fileUtf8: string | undefined, expected: string | null): boolean {
  if (expected === null) return fileUtf8 === undefined;
  if (fileUtf8 === undefined) return false;
  const body = fileUtf8.endsWith('\n') ? fileUtf8.slice(0, -1) : fileUtf8;
  return sha256Utf8(body) === expected;
}

async function recoverLockedIntent(
  deps: FacadeJournalDeps,
): Promise<FacadeJournalIntentV1 | undefined> {
  const intent = await readIntentFile(deps.owner, deps.validator);
  if (!intent) return undefined;
  if (intent.state === 'committed') {
    await fsp.rm(intentPath(deps.owner), { force: true });
    return undefined;
  }

  const claimFile = claimPath(deps.owner, intent.invocationIdDigest);
  const entryFile = entryPath(deps.owner, intent.facadeOperationId);
  const claimRaw = await readUtf8(claimFile);
  const entryRaw = await readUtf8(entryFile);
  const claimUtf8 = claimRaw.status === 'readable' ? claimRaw.utf8 : undefined;
  const entryUtf8 = entryRaw.status === 'readable' ? entryRaw.utf8 : undefined;

  const claimOk = digestMatches(claimUtf8, intent.expectedClaimDigest)
    || digestMatches(claimUtf8, intent.intendedClaimDigest);
  const entryOk = digestMatches(entryUtf8, intent.expectedEntryDigest)
    || digestMatches(entryUtf8, intent.intendedEntryDigest);
  if (!claimOk || !entryOk || claimRaw.status === 'unreadable' || entryRaw.status === 'unreadable') {
    throw new FacadeJournalError(
      'JOURNAL_INVALID',
      'facade journal intent digest mismatch; uncommitted intent is kept',
    );
  }

  if (intent.state === 'prepared') {
    if (claimUtf8 === undefined && entryUtf8 === undefined) return intent;
    throw new FacadeJournalError('JOURNAL_INVALID', 'prepared intent must not have published files');
  }
  if (intent.state === 'claim_published') {
    if (claimUtf8 === undefined) {
      throw new FacadeJournalError('JOURNAL_INVALID', 'claim_published intent is missing claim file');
    }
    return intent;
  }
  if (intent.state === 'entry_published') {
    if (claimUtf8 === undefined || entryUtf8 === undefined) {
      throw new FacadeJournalError('JOURNAL_INVALID', 'entry_published intent is incomplete');
    }
    return intent;
  }
  return intent;
}

async function writeIntent(scope: RegistryOwnerScope, validator: FixtureJournalValidator, intent: FacadeJournalIntentV1): Promise<void> {
  const utf8 = serialize(intent);
  const result = validator.validateIntent(utf8);
  if (!result.ok) {
    throw new FacadeJournalError(
      'JOURNAL_INVALID',
      `facade journal intent schema rejected: ${result.code ?? result.message ?? 'invalid'}`,
    );
  }
  await writeUtf8Atomic(intentPath(scope), utf8);
}

export function structuralJournalValidator(): FixtureJournalValidator {
  const check = (utf8: string, required: string[]): { ok: boolean; code?: string; message?: string } => {
    if (utf8.includes('\r')) return { ok: false, code: 'CRLF_FORBIDDEN', message: 'CR forbidden' };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(utf8) as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'JSON_INVALID', message: 'not json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'SHAPE_INVALID', message: 'not an object' };
    }
    if (parsed.schemaVersion !== 1) {
      return { ok: false, code: 'SCHEMA_VERSION', message: 'schemaVersion must be 1' };
    }
    for (const key of required) {
      if (!(key in parsed)) return { ok: false, code: 'MISSING_FIELD', message: key };
    }
    return { ok: true };
  };
  return {
    validateIntent: (utf8) => check(utf8, [
      'intentId',
      'invocationIdDigest',
      'facadeOperationId',
      'intendedClaimDigest',
      'intendedEntryDigest',
      'state',
    ]),
    validateClaim: (utf8) => check(utf8, [
      'invocationId',
      'invocationIdDigest',
      'facadeOperationId',
      'operationId',
    ]),
    validateEntry: (utf8) => check(utf8, [
      'facadeOperationId',
      'invocationId',
      'operationId',
      'state',
    ]),
  };
}

export async function recoverIntent(deps: FacadeJournalDeps): Promise<FacadeJournalIntentV1 | undefined> {
  return withOwnerJournalLock(deps.owner, () => recoverLockedIntent(deps));
}

export async function readByInvocation(
  deps: FacadeJournalDeps,
  invocationId: string,
): Promise<{ claim: FacadeJournalClaimV1; entry: FacadeJournalEntryStubV1 } | undefined> {
  if (!invocationId) {
    throw new FacadeJournalError('JOURNAL_INVALID', 'invocationId is required');
  }
  return withOwnerJournalLock(deps.owner, async () => {
    await recoverLockedIntent(deps);
    const digest = invocationIdDigest(invocationId);
    const claimFile = claimPath(deps.owner, digest);
    const raw = await readUtf8(claimFile);
    if (raw.status === 'missing') return undefined;
    if (raw.status === 'unreadable' || raw.utf8 === undefined) {
      await isolateInvalid(deps.owner, claimFile);
      throw new FacadeJournalError('JOURNAL_INVALID', 'facade journal claim is unreadable');
    }
    const claim = parseClaim(raw.utf8, deps.validator);
    const entryFile = entryPath(deps.owner, claim.facadeOperationId);
    const entryRaw = await readUtf8(entryFile);
    if (entryRaw.status === 'unreadable' || entryRaw.utf8 === undefined) {
      if (entryRaw.status !== 'missing') await isolateInvalid(deps.owner, entryFile);
      throw new FacadeJournalError('JOURNAL_INVALID', 'facade journal entry is unreadable');
    }
    if (entryRaw.status === 'missing') {
      throw new FacadeJournalError('JOURNAL_INVALID', 'claim exists without entry');
    }
    const entry = parseEntry(entryRaw.utf8, deps.validator);
    return { claim, entry };
  });
}

export async function claimFacadeInvocation(
  deps: FacadeJournalDeps,
  input: { capability?: FacadeInitialCapabilityFixture | null },
): Promise<ClaimResult> {
  if (!input.capability || input.capability.kind !== 'FacadeInitialInvocationCapabilityV1') {
    throw new FacadeJournalError(
      'FACADE_CAPABILITY_REQUIRED',
      'claim requires a fixture FacadeInitialInvocationCapabilityV1',
    );
  }
  if (!input.capability.invocationId) {
    throw new FacadeJournalError('JOURNAL_INVALID', 'capability.invocationId is required');
  }

  const limits = deps.limits ?? DEFAULT_LIMITS;
  const randomUuid = deps.randomUuid ?? randomUUID;

  return withOwnerJournalLock(deps.owner, async () => {
    await assertCapacity(deps.owner, limits, 256);
    const existing = await recoverLockedIntent(deps);
    if (existing && existing.state !== 'committed') {
      throw new FacadeJournalError(
        'JOURNAL_INVALID',
        'uncommitted facade journal intent blocks new claims',
      );
    }

    const invDigest = invocationIdDigest(input.capability!.invocationId);
    const existingClaim = await readUtf8(claimPath(deps.owner, invDigest));
    if (existingClaim.status === 'readable') {
      throw new FacadeJournalError('JOURNAL_INVALID', 'invocationId already claimed');
    }
    if (existingClaim.status === 'unreadable') {
      throw new FacadeJournalError('JOURNAL_INVALID', 'existing claim is unreadable');
    }

    const facadeOperationId = mintId(randomUuid, 'facadeOperationId');
    const operationId = mintId(randomUuid, 'operationId');
    const claim: FacadeJournalClaimV1 = {
      schemaVersion: 1,
      invocationId: input.capability!.invocationId,
      invocationIdDigest: invDigest,
      facadeOperationId,
      operationId,
    };
    const entry: FacadeJournalEntryStubV1 = {
      schemaVersion: 1,
      facadeOperationId,
      invocationId: input.capability!.invocationId,
      operationId,
      state: 'claimed',
    };
    const claimUtf8 = serialize(claim);
    const entryUtf8 = serialize(entry);
    if (!deps.validator.validateClaim(claimUtf8).ok) {
      throw new FacadeJournalError('JOURNAL_INVALID', 'claim fixture validator rejected object');
    }
    if (!deps.validator.validateEntry(entryUtf8).ok) {
      throw new FacadeJournalError('JOURNAL_INVALID', 'entry fixture validator rejected object');
    }

    const intendedClaimDigest = objectDigest(claim);
    const intendedEntryDigest = objectDigest(entry);
    await assertCapacity(deps.owner, limits, Buffer.byteLength(claimUtf8) + Buffer.byteLength(entryUtf8) + 512);

    const intentId = mintId(randomUuid, 'intentId');
    const prepared: FacadeJournalIntentV1 = {
      schemaVersion: 1,
      intentId,
      invocationIdDigest: invDigest,
      facadeOperationId,
      expectedClaimDigest: null,
      expectedEntryDigest: null,
      intendedClaimDigest,
      intendedEntryDigest,
      state: 'prepared',
    };
    await writeIntent(deps.owner, deps.validator, prepared);

    await writeUtf8Atomic(claimPath(deps.owner, invDigest), claimUtf8);
    await writeIntent(deps.owner, deps.validator, { ...prepared, state: 'claim_published' });

    await writeUtf8Atomic(entryPath(deps.owner, facadeOperationId), entryUtf8);
    await writeIntent(deps.owner, deps.validator, { ...prepared, state: 'entry_published' });

    await writeIntent(deps.owner, deps.validator, { ...prepared, state: 'committed' });
    await fsp.rm(intentPath(deps.owner), { force: true });

    return {
      facadeOperationId,
      operationId,
      invocationIdDigest: invDigest,
      claimPath: claimPath(deps.owner, invDigest),
      entryPath: entryPath(deps.owner, facadeOperationId),
    };
  });
}

export const __testOnly = {
  intentPath,
  lockPath,
  writeUtf8Atomic,
  objectDigest,
  serialize,
};
