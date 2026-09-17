/**
 * Host-only owner-scoped workspace identity registry（段 2）。
 *
 * 本机一条 local alias → opaque UUID v4。有 UUID ≠ 启用 xdt ≠ prepareMemorySession。
 * 禁止调用 ownerScopedUserDataPath()（无 owner 会落到 cindy-no-session）。
 * 禁止 OverrideSettingsFile.read() 当权威（它折叠 unreadable 为 defaults）。
 * schema 只读消费 xdt-memory ≥ 80c9b04；仅本机 fixture/schema，不进生产安装探测。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  HEX64_RE,
  UUID_V4_RE,
  XdtPrepareError,
  freezeUtcZ,
  loadXdtSchemaValidator,
  resolveXdtMemoryRoot,
} from '@cindy/maker-core';

import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

const require = createRequire(import.meta.url);

const REGISTRY_FILE = 'workspace-identity-registry-v1.json';
const TRANSACTION_FILE = 'workspace-registry-transaction-v1.json';
const LOCATOR_HASH_PREFIX = 'loc1:';
const EMPTY_REGISTRY_GENERATION = 'reg-empty';

export type RegistryReadStatus = 'missing' | 'readable' | 'unreadable';

export interface WorkspaceIdentityRegistryV1 {
  schemaVersion: 1;
  registryGeneration: string;
  workspaces: Record<string, WorkspaceRecord>;
  aliases: Record<string, AliasRecord>;
}

export interface WorkspaceRecord {
  canonicalWorkspaceId: string;
  state: 'active' | 'retired';
  createdAt: string;
  retiredAt?: string;
}

export interface AliasRecord {
  canonicalWorkspaceId: string;
  locatorKind: 'local' | 'ssh' | 'device';
  locatorDigest: string;
  boundAt: string;
}

export interface WorkspaceRegistryTransactionV1 {
  schemaVersion: 1;
  transactionId: string;
  operationKind: 'registry_only';
  expectedRegistryGeneration: string;
  expectedProviderConfigGeneration: string;
  intendedRegistryGeneration: string;
  intendedProviderConfigGeneration: string;
  registryDigestBefore: string;
  providerSettingsDigestBefore: string;
  registryDigestAfter: string;
  providerSettingsDigestAfter: string;
  state: 'prepared' | 'registry_published' | 'committed';
}

export interface RegistryOwnerScope {
  dataOwnerId: string;
  /** 测试注入的独立 owner 根。生产调用方必须在确认 dataOwnerId 后再自拼路径。 */
  ownerRoot: string;
}

export interface RegistryReadResult {
  status: RegistryReadStatus;
  registry?: WorkspaceIdentityRegistryV1;
  filePath: string;
  utf8?: string;
}

function settingsSentinel(): { generation: string; digest: string } {
  const sentinel = loadXdtSchemaValidator().SETTINGS_UNCHANGED_SENTINEL;
  if (
    sentinel.generation !== 'settings-side-unpublished-v1'
    || sentinel.digest !== '0'.repeat(64)
  ) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'registry_only must consume SETTINGS_UNCHANGED_SENTINEL from xdt-memory ≥ 80c9b04',
    );
  }
  return sentinel;
}

function loadCanonicalDigest(): (utf8: string) => string {
  const root = resolveXdtMemoryRoot();
  const mod = require(path.join(root, 'src/schema-validator/canonical-json.mjs')) as {
    sha256Hex: (utf8: string) => string;
  };
  return mod.sha256Hex;
}

function assertOwnerScope(scope: RegistryOwnerScope): void {
  if (!scope.dataOwnerId) {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'dataOwnerId is required before registry path join or mkdir',
    );
  }
  if (!scope.ownerRoot) {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'ownerRoot is required; do not call ownerScopedUserDataPath() from this module',
    );
  }
  const normalized = path.resolve(scope.ownerRoot);
  if (normalized.toLowerCase().includes('cindy-no-session')) {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'registry must not write cindy-no-session',
    );
  }
}

function registryPath(scope: RegistryOwnerScope): string {
  assertOwnerScope(scope);
  return path.join(scope.ownerRoot, REGISTRY_FILE);
}

function transactionPath(scope: RegistryOwnerScope): string {
  assertOwnerScope(scope);
  return path.join(scope.ownerRoot, TRANSACTION_FILE);
}

function emptyRegistry(): WorkspaceIdentityRegistryV1 {
  return {
    schemaVersion: 1,
    registryGeneration: EMPTY_REGISTRY_GENERATION,
    workspaces: {},
    aliases: {},
  };
}

function serializeRegistry(registry: WorkspaceIdentityRegistryV1): string {
  return `${JSON.stringify(registry)}\n`.replace(/\r/g, '');
}

function digestRegistryUtf8(utf8: string): string {
  const body = utf8.endsWith('\n') ? utf8.slice(0, -1) : utf8;
  return loadCanonicalDigest()(body);
}

function validateKind(kind: string, utf8: string, code: 'CONFIG_INVALID' = 'CONFIG_INVALID'): void {
  if (utf8.includes('\r')) {
    throw new XdtPrepareError(code, `${kind} must not contain CR`);
  }
  const validator = loadXdtSchemaValidator();
  const result = validator.validateUtf8Object({ kind, utf8Bytes: utf8 });
  if (!result.ok) {
    throw new XdtPrepareError(code, `${kind} schema rejected: ${result.code ?? result.message ?? 'invalid'}`);
  }
}

function parseRegistryUtf8(utf8: string): WorkspaceIdentityRegistryV1 {
  const validator = loadXdtSchemaValidator();
  validateKind(validator.KIND.registry, utf8);
  return JSON.parse(utf8) as WorkspaceIdentityRegistryV1;
}

export function assertMinKindRejectsWorkspaces(utf8: string): void {
  const validator = loadXdtSchemaValidator();
  const min = validator.validateUtf8Object({
    kind: validator.KIND.registryMin,
    utf8Bytes: utf8,
  });
  if (min.ok) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'workspace-identity-registry-v1-min must not validate objects with workspaces',
    );
  }
}

function parseTransactionUtf8(utf8: string): WorkspaceRegistryTransactionV1 {
  const validator = loadXdtSchemaValidator();
  validateKind(validator.KIND.registryTransaction, utf8);
  return JSON.parse(utf8) as WorkspaceRegistryTransactionV1;
}

export function localLocatorDigest(absDir: string): { digest: string; normalized: string } {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(absDir);
  } catch {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'local workspace directory is not ready');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'local workspace path is not a directory');
  }
  let normalized = resolved;
  if (process.platform === 'win32') {
    normalized = resolved.replaceAll('\\', '/').toLowerCase();
  }
  const digest = createHash('sha256').update(`${LOCATOR_HASH_PREFIX}${normalized}`, 'utf8').digest('hex');
  if (!HEX64_RE.test(digest)) {
    throw new XdtPrepareError('CONFIG_INVALID', 'locatorDigest must be sha256 hex');
  }
  return { digest, normalized };
}

function aliasKeyForDigest(digest: string): string {
  return `local-${digest}`;
}

function readFileTriState(filePath: string): { status: RegistryReadStatus; utf8?: string } {
  try {
    if (!fs.existsSync(filePath)) return { status: 'missing' };
    const utf8 = fs.readFileSync(filePath, 'utf8');
    return { status: 'readable', utf8 };
  } catch {
    return { status: 'unreadable' };
  }
}

export function readRegistry(scope: RegistryOwnerScope): RegistryReadResult {
  const filePath = registryPath(scope);
  const raw = readFileTriState(filePath);
  if (raw.status === 'missing') return { status: 'missing', filePath };
  if (raw.status === 'unreadable' || raw.utf8 === undefined) {
    return { status: 'unreadable', filePath };
  }
  try {
    const registry = parseRegistryUtf8(raw.utf8);
    return { status: 'readable', registry, filePath, utf8: raw.utf8 };
  } catch {
    return { status: 'unreadable', filePath };
  }
}

function readTransaction(scope: RegistryOwnerScope): WorkspaceRegistryTransactionV1 | undefined {
  const filePath = transactionPath(scope);
  const raw = readFileTriState(filePath);
  if (raw.status === 'missing') return undefined;
  if (raw.status === 'unreadable' || raw.utf8 === undefined) {
    throw new XdtPrepareError('CONFIG_INVALID', 'workspace registry transaction is unreadable');
  }
  try {
    return parseTransactionUtf8(raw.utf8);
  } catch (err) {
    if (err instanceof XdtPrepareError) throw err;
    throw new XdtPrepareError('CONFIG_INVALID', 'workspace registry transaction is unreadable');
  }
}

async function writeUtf8Atomic(filePath: string, utf8: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(tmp, utf8, 'utf8');
  await fsp.rename(tmp, filePath);
}

function findActiveAlias(
  registry: WorkspaceIdentityRegistryV1,
  digest: string,
): AliasRecord | undefined {
  for (const alias of Object.values(registry.aliases)) {
    if (alias.locatorKind !== 'local' || alias.locatorDigest !== digest) continue;
    const workspace = registry.workspaces[alias.canonicalWorkspaceId];
    if (workspace?.state === 'retired') continue;
    return alias;
  }
  return undefined;
}

function recoverTransaction(
  scope: RegistryOwnerScope,
  current: { registry: WorkspaceIdentityRegistryV1; utf8: string },
  txn: WorkspaceRegistryTransactionV1 | undefined,
): { registry: WorkspaceIdentityRegistryV1; utf8: string } {
  if (!txn) return current;
  const sentinel = settingsSentinel();
  const currentDigest = digestRegistryUtf8(current.utf8);
  const settingsOk =
    txn.expectedProviderConfigGeneration === sentinel.generation
    && txn.intendedProviderConfigGeneration === sentinel.generation
    && txn.providerSettingsDigestBefore === sentinel.digest
    && txn.providerSettingsDigestAfter === sentinel.digest;
  if (txn.operationKind !== 'registry_only' || !settingsOk) {
    throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
  }
  if (txn.state === 'prepared' && currentDigest === txn.registryDigestBefore) {
    fs.rmSync(transactionPath(scope), { force: true });
    return current;
  }
  if (txn.state === 'registry_published' && currentDigest === txn.registryDigestAfter) {
    const committed: WorkspaceRegistryTransactionV1 = { ...txn, state: 'committed' };
    const utf8 = `${JSON.stringify(committed)}\n`.replace(/\r/g, '');
    const validator = loadXdtSchemaValidator();
    validateKind(validator.KIND.registryTransaction, utf8);
    fs.writeFileSync(transactionPath(scope), utf8, 'utf8');
    return current;
  }
  if (txn.state === 'committed') return current;
  throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
}

async function withRegistryLock<T>(scope: RegistryOwnerScope, task: () => Promise<T>): Promise<T> {
  assertOwnerScope(scope);
  await fsp.mkdir(scope.ownerRoot, { recursive: true });
  const lockPath = path.join(scope.ownerRoot, `${REGISTRY_FILE}.lock`);
  return withCrossProcessLock(lockPath, { label: 'workspace-identity-registry', waitMs: 12_000 }, async (status) => {
    if (!status.held) {
      throw new XdtPrepareError('CONFIG_INVALID', 'workspace identity registry is busy');
    }
    return task();
  });
}

function loadLockedRegistry(scope: RegistryOwnerScope): {
  registry: WorkspaceIdentityRegistryV1;
  utf8: string;
} {
  const read = readRegistry(scope);
  if (read.status === 'unreadable') {
    throw new XdtPrepareError('CONFIG_INVALID', 'workspace identity registry is unreadable');
  }
  const current =
    read.status === 'missing'
      ? { registry: emptyRegistry(), utf8: serializeRegistry(emptyRegistry()) }
      : { registry: read.registry!, utf8: read.utf8! };
  const txn = readTransaction(scope);
  return recoverTransaction(scope, current, txn);
}

export async function lookupLocalAlias(
  input: RegistryOwnerScope & { absDir: string },
): Promise<{ canonicalWorkspaceId: string; locatorDigest: string }> {
  assertOwnerScope(input);
  const { digest } = localLocatorDigest(input.absDir);
  return withRegistryLock(input, async () => {
    const current = loadLockedRegistry(input);
    const alias = findActiveAlias(current.registry, digest);
    if (!alias) {
      throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'local workspace alias is missing');
    }
    return { canonicalWorkspaceId: alias.canonicalWorkspaceId, locatorDigest: digest };
  });
}

export async function createLocalAlias(
  input: RegistryOwnerScope & { absDir: string; confirmed: true },
): Promise<{ canonicalWorkspaceId: string; locatorDigest: string; created: boolean }> {
  assertOwnerScope(input);
  if (input.confirmed !== true) {
    throw new XdtPrepareError('WORKSPACE_IDENTITY_REQUIRED', 'createLocalAlias requires confirmed === true');
  }
  const { digest } = localLocatorDigest(input.absDir);
  return withRegistryLock(input, async () => {
    const current = loadLockedRegistry(input);
    const existing = findActiveAlias(current.registry, digest);
    if (existing) {
      return {
        canonicalWorkspaceId: existing.canonicalWorkspaceId,
        locatorDigest: digest,
        created: false,
      };
    }
    for (const alias of Object.values(current.registry.aliases)) {
      if (alias.locatorKind !== 'local' || alias.locatorDigest !== digest) continue;
      const workspace = current.registry.workspaces[alias.canonicalWorkspaceId];
      if (workspace?.state === 'retired') continue;
      throw new XdtPrepareError(
        'WORKSPACE_IDENTITY_CONFLICT',
        'locatorDigest already bound to another active canonicalWorkspaceId',
      );
    }

    const now = freezeUtcZ(new Date().toISOString());
    const canonicalWorkspaceId = randomUUID();
    if (!UUID_V4_RE.test(canonicalWorkspaceId)) {
      throw new XdtPrepareError('CONFIG_INVALID', 'canonicalWorkspaceId must be UUID v4');
    }
    const nextGeneration = `reg-${canonicalWorkspaceId}`;
    const next: WorkspaceIdentityRegistryV1 = {
      schemaVersion: 1,
      registryGeneration: nextGeneration,
      workspaces: {
        ...current.registry.workspaces,
        [canonicalWorkspaceId]: {
          canonicalWorkspaceId,
          state: 'active',
          createdAt: now,
        },
      },
      aliases: {
        ...current.registry.aliases,
        [aliasKeyForDigest(digest)]: {
          canonicalWorkspaceId,
          locatorKind: 'local',
          locatorDigest: digest,
          boundAt: now,
        },
      },
    };
    const nextUtf8 = serializeRegistry(next);
    const validator = loadXdtSchemaValidator();
    validateKind(validator.KIND.registry, nextUtf8);
    const sentinel = settingsSentinel();
    const txnPrepared: WorkspaceRegistryTransactionV1 = {
      schemaVersion: 1,
      transactionId: randomUUID(),
      operationKind: 'registry_only',
      expectedRegistryGeneration: current.registry.registryGeneration,
      expectedProviderConfigGeneration: sentinel.generation,
      intendedRegistryGeneration: nextGeneration,
      intendedProviderConfigGeneration: sentinel.generation,
      registryDigestBefore: digestRegistryUtf8(current.utf8),
      providerSettingsDigestBefore: sentinel.digest,
      registryDigestAfter: digestRegistryUtf8(nextUtf8),
      providerSettingsDigestAfter: sentinel.digest,
      state: 'prepared',
    };
    const writeTxn = async (state: WorkspaceRegistryTransactionV1['state']) => {
      const body: WorkspaceRegistryTransactionV1 = { ...txnPrepared, state };
      const utf8 = `${JSON.stringify(body)}\n`.replace(/\r/g, '');
      validateKind(validator.KIND.registryTransaction, utf8);
      await writeUtf8Atomic(transactionPath(input), utf8);
    };
    await writeTxn('prepared');
    await writeUtf8Atomic(registryPath(input), nextUtf8);
    await writeTxn('registry_published');
    await writeTxn('committed');
    return { canonicalWorkspaceId, locatorDigest: digest, created: true };
  });
}

export const __testOnly = {
  aliasKeyForDigest,
  emptyRegistry,
  localLocatorDigest,
  registryPath,
  settingsSentinel,
  transactionPath,
  LOCATOR_HASH_PREFIX,
};
