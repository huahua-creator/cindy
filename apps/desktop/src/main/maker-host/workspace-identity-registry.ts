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
const SETTINGS_FILE = 'memory-provider-settings-v1.json';
const BOOLEAN_MEMORY_SETTINGS_FILE = 'memory-settings.json';
const LOCATOR_HASH_PREFIX = 'loc1:';
const EMPTY_REGISTRY_GENERATION = 'reg-empty';
const MISSING_SETTINGS_DIGEST = createHash('sha256').update('', 'utf8').digest('hex');
const PROVIDER_SETTINGS_KIND = 'memory-provider-settings-v1';

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

export type MemoryProviderKind = 'internal' | 'xdt';

export interface MemoryProviderSettingsV1 {
  schemaVersion: 1;
  defaultProvider: MemoryProviderKind;
  workspaceOverrides: Record<string, MemoryProviderKind>;
  xdt?: {
    serverRegistrationId: string;
    serverRegistrationGeneration: string;
    serverRegistrationDigest: string;
  };
  configGeneration: string;
}

interface WorkspaceRegistryTransactionIdentityV1 {
  schemaVersion: 1;
  transactionId: string;
  expectedRegistryGeneration: string;
  expectedProviderConfigGeneration: string;
  intendedRegistryGeneration: string;
  intendedProviderConfigGeneration: string;
  registryDigestBefore: string;
  providerSettingsDigestBefore: string;
  registryDigestAfter: string;
  providerSettingsDigestAfter: string;
}

export type WorkspaceRegistryTransactionV1 =
  | (WorkspaceRegistryTransactionIdentityV1 & {
      operationKind: 'settings_only';
      state: 'prepared' | 'settings_published' | 'committed';
    })
  | (WorkspaceRegistryTransactionIdentityV1 & {
      operationKind: 'registry_only';
      state: 'prepared' | 'registry_published' | 'committed';
    });

export type ProviderSettingsReadStatus = RegistryReadStatus | 'invalid';

export interface ProviderSettingsReadResult {
  status: ProviderSettingsReadStatus;
  settings?: MemoryProviderSettingsV1;
  filePath: string;
  utf8?: string;
  effectiveProvider: MemoryProviderKind | undefined;
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

function settingsPath(scope: RegistryOwnerScope): string {
  assertOwnerScope(scope);
  return path.join(scope.ownerRoot, SETTINGS_FILE);
}

function booleanMemorySettingsPath(scope: RegistryOwnerScope): string {
  assertOwnerScope(scope);
  return path.join(scope.ownerRoot, BOOLEAN_MEMORY_SETTINGS_FILE);
}

function providerSettingsKind(): string {
  return loadXdtSchemaValidator().KIND.providerSettings ?? PROVIDER_SETTINGS_KIND;
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

function serializeSettings(settings: MemoryProviderSettingsV1): string {
  return `${JSON.stringify(settings)}\n`.replace(/\r/g, '');
}

function serializeTransaction(txn: WorkspaceRegistryTransactionV1): string {
  return `${JSON.stringify(txn)}\n`.replace(/\r/g, '');
}

function digestCanonicalUtf8(utf8: string): string {
  const body = utf8.endsWith('\n') ? utf8.slice(0, -1) : utf8;
  return loadCanonicalDigest()(body);
}

function digestRegistryUtf8(utf8: string): string {
  return digestCanonicalUtf8(utf8);
}

function digestSettingsUtf8(utf8: string): string {
  return digestCanonicalUtf8(utf8);
}

function emptyRegistryDigest(): string {
  return digestRegistryUtf8(serializeRegistry(emptyRegistry()));
}

function missingSettingsDigest(): string {
  return MISSING_SETTINGS_DIGEST;
}

function assertDigestNamespaces(): void {
  const sentinel = settingsSentinel();
  if (MISSING_SETTINGS_DIGEST === sentinel.digest) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'missing settings digest must not equal SETTINGS_UNCHANGED_SENTINEL',
    );
  }
  if (MISSING_SETTINGS_DIGEST === emptyRegistryDigest()) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'missing settings digest must not equal empty registry digest',
    );
  }
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
  const txn = JSON.parse(utf8) as WorkspaceRegistryTransactionV1 | {
    operationKind?: string;
    state?: string;
  };
  if (txn.operationKind === 'registry_and_settings') {
    throw new XdtPrepareError('CONFIG_INVALID', 'registry_and_settings is not implemented');
  }
  if (txn.operationKind !== 'registry_only' && txn.operationKind !== 'settings_only') {
    throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
  }
  if (txn.operationKind === 'registry_only') {
    if (txn.state !== 'prepared' && txn.state !== 'registry_published' && txn.state !== 'committed') {
      throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
    }
  } else if (txn.state !== 'prepared' && txn.state !== 'settings_published' && txn.state !== 'committed') {
    throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
  }
  return txn as WorkspaceRegistryTransactionV1;
}

function parseSettingsUtf8(utf8: string): MemoryProviderSettingsV1 {
  validateKind(providerSettingsKind(), utf8);
  const settings = JSON.parse(utf8) as MemoryProviderSettingsV1;
  if (settings.defaultProvider === 'xdt' && !settings.xdt) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'defaultProvider=xdt requires a server registration object',
    );
  }
  return settings;
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

function readSettingsRaw(scope: RegistryOwnerScope): {
  status: RegistryReadStatus;
  utf8?: string;
  filePath: string;
} {
  const filePath = settingsPath(scope);
  const raw = readFileTriState(filePath);
  if (raw.status === 'missing') return { status: 'missing', filePath };
  if (raw.status === 'unreadable' || raw.utf8 === undefined) {
    return { status: 'unreadable', filePath };
  }
  return { status: 'readable', utf8: raw.utf8, filePath };
}

function currentSettingsDigest(scope: RegistryOwnerScope): {
  status: RegistryReadStatus;
  digest: string;
  utf8?: string;
} {
  const raw = readSettingsRaw(scope);
  if (raw.status === 'missing') {
    return { status: 'missing', digest: missingSettingsDigest() };
  }
  if (raw.status === 'unreadable' || raw.utf8 === undefined) {
    throw new XdtPrepareError('CONFIG_INVALID', 'memory provider settings is unreadable');
  }
  parseSettingsUtf8(raw.utf8);
  const digest = digestSettingsUtf8(raw.utf8);
  if (digest === missingSettingsDigest()) {
    throw new XdtPrepareError('CONFIG_INVALID', 'memory provider settings is invalid');
  }
  return { status: 'readable', digest, utf8: raw.utf8 };
}

function currentRegistrySnapshot(scope: RegistryOwnerScope): {
  registry: WorkspaceIdentityRegistryV1;
  utf8: string;
  digest: string;
} {
  const read = readRegistry(scope);
  if (read.status === 'unreadable') {
    throw new XdtPrepareError('CONFIG_INVALID', 'workspace identity registry is unreadable');
  }
  const current =
    read.status === 'missing'
      ? { registry: emptyRegistry(), utf8: serializeRegistry(emptyRegistry()) }
      : { registry: read.registry!, utf8: read.utf8! };
  return { ...current, digest: digestRegistryUtf8(current.utf8) };
}

function assertUnchangedRegistrySide(
  txn: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'settings_only' }>,
  registryDigest: string,
): void {
  if (
    txn.intendedRegistryGeneration !== txn.expectedRegistryGeneration
    || txn.registryDigestAfter !== txn.registryDigestBefore
  ) {
    throw new XdtPrepareError('CONFIG_INVALID', 'settings_only must keep registry generation unchanged');
  }
  if (registryDigest !== txn.registryDigestBefore || registryDigest !== txn.registryDigestAfter) {
    throw new XdtPrepareError('CONFIG_INVALID', 'settings_only unchanged registry digest drifted');
  }
}

async function persistTransaction(scope: RegistryOwnerScope, txn: WorkspaceRegistryTransactionV1): Promise<void> {
  const utf8 = serializeTransaction(txn);
  validateKind(loadXdtSchemaValidator().KIND.registryTransaction, utf8);
  await writeUtf8Atomic(transactionPath(scope), utf8);
}

type SettingsRecoverHook = (afterFillState: 'settings_published') => void | Promise<void>;
let settingsRecoverHook: SettingsRecoverHook | undefined;

function setSettingsRecoverHookForTest(hook: SettingsRecoverHook | undefined): void {
  settingsRecoverHook = hook;
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

async function recoverRegistryOnlyTransaction(
  scope: RegistryOwnerScope,
  current: { registry: WorkspaceIdentityRegistryV1; utf8: string },
  txn: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'registry_only' }>,
): Promise<{ registry: WorkspaceIdentityRegistryV1; utf8: string }> {
  const sentinel = settingsSentinel();
  const currentDigest = digestRegistryUtf8(current.utf8);
  const settingsOk =
    txn.expectedProviderConfigGeneration === sentinel.generation
    && txn.intendedProviderConfigGeneration === sentinel.generation
    && txn.providerSettingsDigestBefore === sentinel.digest
    && txn.providerSettingsDigestAfter === sentinel.digest;
  if (!settingsOk) {
    throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
  }
  if (txn.state === 'prepared' && currentDigest === txn.registryDigestBefore) {
    fs.rmSync(transactionPath(scope), { force: true });
    return current;
  }
  if (txn.state === 'registry_published' && currentDigest === txn.registryDigestAfter) {
    await persistTransaction(scope, { ...txn, state: 'committed' });
    return current;
  }
  if (txn.state === 'committed') return current;
  throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
}

async function recoverSettingsOnlyTransaction(
  scope: RegistryOwnerScope,
  txn: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'settings_only' }>,
): Promise<void> {
  assertDigestNamespaces();
  const reread = () => {
    const registry = currentRegistrySnapshot(scope);
    const settings = currentSettingsDigest(scope);
    assertUnchangedRegistrySide(txn, registry.digest);
    return { registry, settings };
  };

  const fillCommitted = async (
    currentTxn: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'settings_only' }>,
  ) => {
    const snapshot = reread();
    if (
      snapshot.settings.status !== 'readable'
      || snapshot.settings.digest !== currentTxn.providerSettingsDigestAfter
      || !snapshot.settings.utf8
    ) {
      throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
    }
    parseSettingsUtf8(snapshot.settings.utf8);
    await persistTransaction(scope, { ...currentTxn, state: 'committed' });
  };

  if (txn.state === 'prepared') {
    const snapshot = reread();
    if (snapshot.settings.digest === txn.providerSettingsDigestBefore) {
      if (txn.providerSettingsDigestBefore === missingSettingsDigest() && snapshot.settings.status !== 'missing') {
        throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
      }
      fs.rmSync(transactionPath(scope), { force: true });
      return;
    }
    if (snapshot.settings.digest === txn.providerSettingsDigestAfter) {
      if (snapshot.settings.status !== 'readable' || !snapshot.settings.utf8) {
        throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
      }
      parseSettingsUtf8(snapshot.settings.utf8);
      await persistTransaction(scope, { ...txn, state: 'settings_published' });
      await settingsRecoverHook?.('settings_published');
      await fillCommitted({ ...txn, state: 'settings_published' });
      return;
    }
    throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
  }

  if (txn.state === 'settings_published') {
    const snapshot = reread();
    if (snapshot.settings.digest === txn.providerSettingsDigestAfter) {
      if (snapshot.settings.status !== 'readable') {
        throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
      }
      await fillCommitted(txn);
      return;
    }
    throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
  }

  if (txn.state === 'committed') {
    const snapshot = reread();
    if (
      snapshot.registry.registry.registryGeneration !== txn.intendedRegistryGeneration
      || snapshot.settings.status !== 'readable'
      || snapshot.settings.utf8 === undefined
    ) {
      throw new XdtPrepareError('CONFIG_INVALID', 'committed settings_only generation pair mismatch');
    }
    const settings = parseSettingsUtf8(snapshot.settings.utf8);
    if (settings.configGeneration !== txn.intendedProviderConfigGeneration) {
      throw new XdtPrepareError('CONFIG_INVALID', 'committed settings_only generation pair mismatch');
    }
    return;
  }

  throw new XdtPrepareError('CONFIG_INVALID', 'incomplete workspace registry transaction');
}

async function recoverTransaction(
  scope: RegistryOwnerScope,
  current: { registry: WorkspaceIdentityRegistryV1; utf8: string },
  txn: WorkspaceRegistryTransactionV1 | undefined,
): Promise<{ registry: WorkspaceIdentityRegistryV1; utf8: string }> {
  if (!txn) return current;
  if (txn.operationKind === 'registry_only') {
    return recoverRegistryOnlyTransaction(scope, current, txn);
  }
  if (txn.operationKind === 'settings_only') {
    await recoverSettingsOnlyTransaction(scope, txn);
    return currentRegistrySnapshot(scope);
  }
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

async function loadLockedRegistry(scope: RegistryOwnerScope): Promise<{
  registry: WorkspaceIdentityRegistryV1;
  utf8: string;
}> {
  const current = currentRegistrySnapshot(scope);
  const txn = readTransaction(scope);
  return recoverTransaction(scope, current, txn);
}


export async function lookupLocalAlias(
  input: RegistryOwnerScope & { absDir: string },
): Promise<{ canonicalWorkspaceId: string; locatorDigest: string }> {
  assertOwnerScope(input);
  const { digest } = localLocatorDigest(input.absDir);
  return withRegistryLock(input, async () => {
    const current = await loadLockedRegistry(input);
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
    const current = await loadLockedRegistry(input);
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
    const writeTxn = async (
      state: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'registry_only' }>['state'],
    ) => {
      const body: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'registry_only' }> = {
        ...txnPrepared,
        state,
      };
      const utf8 = serializeTransaction(body);
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

export function readMemoryProviderSettings(scope: RegistryOwnerScope): ProviderSettingsReadResult {
  assertOwnerScope(scope);
  const raw = readSettingsRaw(scope);
  if (raw.status === 'missing') {
    return {
      status: 'missing',
      filePath: raw.filePath,
      effectiveProvider: 'internal',
    };
  }
  if (raw.status === 'unreadable' || raw.utf8 === undefined) {
    return { status: 'unreadable', filePath: raw.filePath, effectiveProvider: undefined };
  }
  try {
    const settings = parseSettingsUtf8(raw.utf8);
    return {
      status: 'readable',
      settings,
      filePath: raw.filePath,
      utf8: raw.utf8,
      effectiveProvider: settings.defaultProvider,
    };
  } catch {
    return { status: 'invalid', filePath: raw.filePath, utf8: raw.utf8, effectiveProvider: undefined };
  }
}

export async function loadMemoryProviderSettings(
  scope: RegistryOwnerScope,
): Promise<ProviderSettingsReadResult> {
  assertOwnerScope(scope);
  const txnPresent = readFileTriState(transactionPath(scope)).status !== 'missing';
  const settingsPresent = readFileTriState(settingsPath(scope)).status !== 'missing';
  if (!txnPresent && !settingsPresent) {
    return readMemoryProviderSettings(scope);
  }
  return withRegistryLock(scope, async () => {
    await loadLockedRegistry(scope);
    const read = readMemoryProviderSettings(scope);
    if (read.status === 'unreadable' || read.status === 'invalid') {
      throw new XdtPrepareError('CONFIG_INVALID', 'memory provider settings is invalid');
    }
    return read;
  });
}

export async function publishMemoryProviderSettings(
  scope: RegistryOwnerScope & { settings: MemoryProviderSettingsV1 },
): Promise<MemoryProviderSettingsV1> {
  assertOwnerScope(scope);
  assertDigestNamespaces();
  const nextUtf8 = serializeSettings(scope.settings);
  parseSettingsUtf8(nextUtf8);
  const afterDigest = digestSettingsUtf8(nextUtf8);

  return withRegistryLock(scope, async () => {
    await loadLockedRegistry(scope);
    const registry = currentRegistrySnapshot(scope);
    const before = currentSettingsDigest(scope);
    if (before.status === 'readable' && before.utf8) {
      const previous = parseSettingsUtf8(before.utf8);
      if (previous.configGeneration === scope.settings.configGeneration) {
        throw new XdtPrepareError('CONFIG_INVALID', 'settings_only must mint a new configGeneration');
      }
    }
    if (afterDigest === before.digest) {
      throw new XdtPrepareError('CONFIG_INVALID', 'settings_only must change provider settings digest');
    }

    const txnPrepared: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'settings_only' }> = {
      schemaVersion: 1,
      transactionId: randomUUID(),
      operationKind: 'settings_only',
      expectedRegistryGeneration: registry.registry.registryGeneration,
      expectedProviderConfigGeneration:
        before.status === 'readable' && before.utf8
          ? parseSettingsUtf8(before.utf8).configGeneration
          : 'settings-unpublished',
      intendedRegistryGeneration: registry.registry.registryGeneration,
      intendedProviderConfigGeneration: scope.settings.configGeneration,
      registryDigestBefore: registry.digest,
      providerSettingsDigestBefore: before.digest,
      registryDigestAfter: registry.digest,
      providerSettingsDigestAfter: afterDigest,
      state: 'prepared',
    };

    const writeTxn = async (
      state: Extract<WorkspaceRegistryTransactionV1, { operationKind: 'settings_only' }>['state'],
    ) => {
      await persistTransaction(scope, { ...txnPrepared, state });
    };

    const rereadBoth = () => {
      const liveRegistry = currentRegistrySnapshot(scope);
      const liveSettings = currentSettingsDigest(scope);
      assertUnchangedRegistrySide(txnPrepared, liveRegistry.digest);
      return liveSettings;
    };

    await writeTxn('prepared');
    rereadBoth();
    await writeUtf8Atomic(settingsPath(scope), nextUtf8);
    const afterPublish = rereadBoth();
    if (afterPublish.status !== 'readable' || afterPublish.digest !== afterDigest) {
      throw new XdtPrepareError('CONFIG_INVALID', 'settings_only published digest drifted');
    }
    await writeTxn('settings_published');
    await settingsRecoverHook?.('settings_published');
    const afterFill = rereadBoth();
    if (afterFill.status !== 'readable' || afterFill.digest !== afterDigest) {
      throw new XdtPrepareError('CONFIG_INVALID', 'settings_only published digest drifted');
    }
    await writeTxn('committed');
    return scope.settings;
  });
}

export const __testOnly = {
  aliasKeyForDigest,
  emptyRegistry,
  emptyRegistryDigest,
  localLocatorDigest,
  missingSettingsDigest,
  registryPath,
  settingsPath,
  booleanMemorySettingsPath,
  settingsSentinel,
  setSettingsRecoverHookForTest,
  transactionPath,
  LOCATOR_HASH_PREFIX,
  SETTINGS_FILE,
};
