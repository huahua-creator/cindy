/**
 * 段 5：已确认 UUID 的本机合格会话，对生产形 xdt 树只读 prepareMemorySession。
 *
 * 不改 attach-session-workspace-identity.ts。有 UUID ≠ 默认启用 xdt：
 * 未登记 / 不合格 / remote / review / Codex+stanza / Maker Memory 关 → skip。
 * 成功路径必须注入完整 PreparedMemorySession 对象并 remember。
 * 失败必须在本钩子内回滚 opts + remember（prepareStartOptions 抛错时 onClose 不会跑）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AgentKind, BaseAgent, CreateSessionOptions, MakerMemoryManager } from '@cindy/maker-core';
import {
  HEX64_RE,
  XdtPrepareError,
  assertXdtBindingSchema,
  cindyIsolatedCodexConfigPath,
  loadXdtSchemaValidator,
  readIsolatedCodexStanzaPresent,
  resolveXdtMemoryRoot,
  type PreparedMemorySession,
  type XdtIndexSource,
  type XdtMemoryBindingV1,
} from '@cindy/maker-core';

import { getActiveAppSession } from '../appSessionState.js';
import {
  bindPreparedMemorySessionToSessionId,
  forgetPreparedMemorySession,
  forgetPreparedMemorySessionForSessionId,
  prepareAndRememberMemorySession,
} from './prepared-memory-sessions.js';
import { getSessionWorkspaceIdentity } from './session-workspace-identity.js';
import { readRegistry, type RegistryOwnerScope } from './workspace-identity-registry.js';
import { resolveOwnerScopedRegistryRoot } from './workspace-identity-assembler.js';

/**
 * Host 只读 index registration 的稳定 UUID v4。
 * 不是每会话 randomUUID()，也不是 isolated Codex stanza，也不是 fixture 1111…/2222…。
 * 材料哈希进 serverRegistrationDigest； Cindy 升级后同一 Host 只读入口保持同一 id。
 */
export const CINDY_HOST_READONLY_SERVER_REGISTRATION_ID =
  '7c4e9b12-3a80-4f1d-9c6e-2b8d5a1f0e73';

const SERVER_REGISTRATION_GENERATION = 'cindy-host-readonly-v1';

export interface PrepareReadonlyXdtSessionDeps {
  getAgent: (kind: AgentKind) => BaseAgent | undefined;
  getMakerMemory: () => MakerMemoryManager | undefined;
  resolveOwner: () => RegistryOwnerScope;
  readRegistry: typeof readRegistry;
  getIdentity: typeof getSessionWorkspaceIdentity;
  userDataDir: () => string;
  resolveIndexSource: (workspace: string) => XdtIndexSource;
  xdtMemoryRoot?: string;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertExistingDirectory(abs: string, label: string): void {
  let stat: fs.Stats;
  try {
    if (!fs.existsSync(abs)) {
      throw new XdtPrepareError('CONFIG_INVALID', `${label} is missing`);
    }
    stat = fs.statSync(abs);
  } catch (err) {
    if (err instanceof XdtPrepareError) throw err;
    throw new XdtPrepareError('CONFIG_INVALID', `${label} is not a directory`);
  }
  if (!stat.isDirectory()) {
    throw new XdtPrepareError('CONFIG_INVALID', `${label} is not a directory`);
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeSegmentEquals(value: string): boolean {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return normalized === value;
}

/**
 * Host-only extra read label. Basename is never written as canonical workspace.
 * Illegal labels are dropped (UUID-only empty shell), not rewritten.
 */
export function extraReadWorkspacesFromWorkingDir(
  workingDir: string | undefined,
  canonicalWorkspaceId: string,
  dataRoot?: string,
): string[] {
  if (!workingDir) return [];
  const rawSegment = workingDir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (!rawSegment || rawSegment === '.' || rawSegment === '..' || rawSegment === '_global') {
    return [];
  }
  if (/[\\/\0]/.test(rawSegment)) return [];
  const base = path.basename(path.resolve(workingDir));
  if (!base || base !== rawSegment) return [];
  if (base === '.' || base === '..' || base === '_global') return [];
  if (UUID_V4.test(base) || base === canonicalWorkspaceId) return [];
  if (path.win32.isAbsolute(base) || path.isAbsolute(base)) return [];
  if (!safeSegmentEquals(base)) return [];
  if (dataRoot) {
    const recordsRoot = path.resolve(dataRoot, 'records');
    const resolved = path.resolve(recordsRoot, base);
    if (path.basename(resolved) !== base) return [];
    const relative = path.relative(recordsRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || resolved === recordsRoot) {
      return [];
    }
  }
  return [base];
}

function defaultIndexSource(workspace: string): XdtIndexSource {
  const repoRoot = resolveXdtMemoryRoot();
  const dataRoot = process.env.XDT_MEMORY_HOME || path.join(repoRoot, 'data');
  return {
    repoRoot,
    dataRoot,
    workspace,
    device: 'cindy-host-readonly',
  };
}

function defaultDeps(): PrepareReadonlyXdtSessionDeps {
  return {
    getAgent: () => undefined,
    getMakerMemory: () => undefined,
    resolveOwner: resolveOwnerScopedRegistryRoot,
    readRegistry,
    getIdentity: getSessionWorkspaceIdentity,
    userDataDir: () => {
      throw new XdtPrepareError(
        'CONFIG_INVALID',
        'userDataDir must be injected; empty default would resolve a relative Codex stanza path',
      );
    },
    resolveIndexSource: defaultIndexSource,
  };
}

function ownerScopeFingerprint(dataOwnerId: string): string {
  const digest = sha256Hex(`owner-scope-v1:${dataOwnerId}`);
  if (!HEX64_RE.test(digest)) {
    throw new XdtPrepareError('CONFIG_INVALID', 'ownerScopeFingerprint must be sha256 hex');
  }
  return digest;
}

function assembleBinding(input: {
  canonicalWorkspaceId: string;
  registryGeneration: string;
  dataOwnerId: string;
  ownerEpoch: string;
  xdtMemoryRoot?: string;
}): XdtMemoryBindingV1 {
  const sentinel = loadXdtSchemaValidator(input.xdtMemoryRoot).SETTINGS_UNCHANGED_SENTINEL;
  const ownerFp = ownerScopeFingerprint(input.dataOwnerId);
  const registrationDigest = sha256Hex(
    `cindy-host-readonly:${CINDY_HOST_READONLY_SERVER_REGISTRATION_ID}:${SERVER_REGISTRATION_GENERATION}`,
  );
  const bindingDigest = sha256Hex(
    [
      input.canonicalWorkspaceId,
      input.registryGeneration,
      sentinel.generation,
      sentinel.digest,
      ownerFp,
      input.ownerEpoch,
      CINDY_HOST_READONLY_SERVER_REGISTRATION_ID,
      SERVER_REGISTRATION_GENERATION,
      registrationDigest,
    ].join(':'),
  );
  const binding: XdtMemoryBindingV1 = {
    schemaVersion: 1,
    ownerScopeFingerprint: ownerFp,
    ownerEpoch: input.ownerEpoch,
    configGeneration: sentinel.generation,
    registryGeneration: input.registryGeneration,
    bindingDigest,
    enabled: true,
    provider: 'xdt',
    canonicalWorkspaceId: input.canonicalWorkspaceId,
    serverRegistrationId: CINDY_HOST_READONLY_SERVER_REGISTRATION_ID,
    serverRegistrationGeneration: SERVER_REGISTRATION_GENERATION,
    serverRegistrationDigest: registrationDigest,
  };
  assertXdtBindingSchema(binding, input.xdtMemoryRoot);
  return binding;
}

function rollbackPreparedOpts(opts: CreateSessionOptions, sessionId: string, preparedId?: string): void {
  delete opts.preparedMemorySession;
  forgetPreparedMemorySessionForSessionId(sessionId);
  if (preparedId) forgetPreparedMemorySession(preparedId);
}

function sessionMemoryWouldEnable(
  opts: CreateSessionOptions,
  manager: MakerMemoryManager | undefined,
): boolean {
  if (opts.makerMemoryEnabled === false) return false;
  if (opts.makerMemoryEnabled === true) return true;
  return manager?.isEnabled() === true;
}

export async function prepareReadonlyXdtSession(
  sessionId: string,
  opts: CreateSessionOptions,
  overrides: Partial<PrepareReadonlyXdtSessionDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };
  if (opts.preparedMemorySession) return;
  if (opts.remoteHostId) return;
  if (opts.reviewMode) return;
  const forcedXdt = (opts as CreateSessionOptions & { memoryProviderRequested?: unknown })
    .memoryProviderRequested === 'xdt';
  if (forcedXdt) {
    throw new XdtPrepareError(
      'WORKSPACE_IDENTITY_REQUIRED',
      'forced xdt without a prepared binding is fail-closed; no half-injection',
    );
  }

  const identity = deps.getIdentity(sessionId);
  if (!identity) return;

  const manager = deps.getMakerMemory();
  if (!sessionMemoryWouldEnable(opts, manager)) return;

  const userDataDir = deps.userDataDir();
  if (!userDataDir) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      'userDataDir must be injected; empty default would resolve a relative Codex stanza path',
    );
  }
  const isolatedStanzaPresent = readIsolatedCodexStanzaPresent(
    cindyIsolatedCodexConfigPath(userDataDir),
  );
  if (opts.agentKind === 'codex' && isolatedStanzaPresent) return;

  const sessionInstanceId = opts.sessionInstanceId;
  if (!sessionInstanceId) {
    throw new XdtPrepareError('CONFIG_INVALID', 'sessionInstanceId must be minted before prepare');
  }

  const agent = deps.getAgent(opts.agentKind);
  if (!agent) {
    throw new XdtPrepareError('CONFIG_INVALID', `agent ${opts.agentKind} is not registered`);
  }
  if (!manager) {
    throw new XdtPrepareError('MAKER_MEMORY_NOT_READY', 'maker memory manager is required for xdt prepare');
  }

  let owner: RegistryOwnerScope;
  try {
    owner = deps.resolveOwner();
  } catch (err) {
    if (err instanceof XdtPrepareError && err.code === 'CONFIG_INVALID') throw err;
    return;
  }

  const read = deps.readRegistry(owner);
  if (read.status === 'unreadable') {
    throw new XdtPrepareError('CONFIG_INVALID', 'workspace identity registry is unreadable');
  }
  if (read.status === 'missing' || !read.registry) return;

  const indexSource = deps.resolveIndexSource(identity.canonicalWorkspaceId);
  assertExistingDirectory(indexSource.repoRoot, 'xdt repoRoot');
  assertExistingDirectory(indexSource.dataRoot, 'xdt dataRoot');
  const extraReadWorkspaces = indexSource.extraReadWorkspaces
    ?? extraReadWorkspacesFromWorkingDir(
      opts.workingDir,
      identity.canonicalWorkspaceId,
      indexSource.dataRoot,
    );

  const binding = assembleBinding({
    canonicalWorkspaceId: identity.canonicalWorkspaceId,
    registryGeneration: read.registry.registryGeneration,
    dataOwnerId: owner.dataOwnerId,
    ownerEpoch: `cindy-host-readonly-epoch-${getActiveAppSession().generation}`,
    xdtMemoryRoot: deps.xdtMemoryRoot,
  });

  const nativeSetResult = await agent.setMemory(false);
  const nativeObservedStatus = await agent.getMemoryStatus();

  let prepared: PreparedMemorySession | undefined;
  try {
    prepared = await prepareAndRememberMemorySession({
      agentKind: opts.agentKind,
      sessionInstanceId,
      binding,
      isolatedStanzaPresent,
      nativeSetResult,
      nativeObservedStatus,
      indexSource: {
        ...indexSource,
        device: indexSource.device ?? 'cindy-host-readonly',
        extraReadWorkspaces,
      },
      xdtReadOnlyScope: identity.canonicalWorkspaceId,
      makerMemory: manager,
      xdtMemoryRoot: deps.xdtMemoryRoot,
    });
    opts.preparedMemorySession = prepared;
    bindPreparedMemorySessionToSessionId(sessionId, prepared.preparedMemorySessionId);
  } catch (err) {
    rollbackPreparedOpts(opts, sessionId, prepared?.preparedMemorySessionId);
    throw err;
  }
}
