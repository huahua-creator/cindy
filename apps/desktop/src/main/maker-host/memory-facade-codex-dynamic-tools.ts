/**
 * 前置刀 1b：Cindy Codex mutation 入口走 Host dynamic tool。
 * 能力只在进程内 mint；模型 args/_meta 里的 invocationId/capability 一律 INVALID_ARGS。
 * inner 仍返回现网禁写，不改 write.ts:55，不接线 memory_write 成功。
 */

import { randomUUID } from 'node:crypto';

import type {
  CodexHostDynamicToolContext,
  CodexHostDynamicToolProvider,
  DynamicToolCallResponse,
  PreparedMemorySession,
} from '@cindy/maker-core';
import { freezeUtcZ, UUID_V4_RE, XdtPrepareError } from '@cindy/maker-core';

import { objectDigest } from './facade-canonical.js';
import {
  mintFacadeInitialCapability,
  verifyFacadeInitialCapability,
  type FacadeInnerToolName,
} from './facade-capability.js';
import {
  claimFacadeInvocation,
  FacadeJournalError,
  ownerScopeDigest,
  readByInvocation,
} from './facade-journal.js';
import {
  FacadeInvocationLedgerError,
  fillInvocationLedgerOperationIds,
  readCallIndexInvocationId,
  readInvocationLedger,
  writeIdentityLedger,
  type CallIdentity,
  type FacadeInvocationLedgerV1,
} from './facade-invocation-ledger.js';
import type { RegistryOwnerScope } from './workspace-identity-registry.js';

type DynamicToolSpec = ReturnType<CodexHostDynamicToolProvider['listTools']>[number];
type DynamicToolCallParams = Parameters<CodexHostDynamicToolProvider['callTool']>[0];

const NAMESPACE = 'cindy_memory_facade';
const FLAT_TOOL_SEPARATOR = '__';
const LIST_TOOLS_NAME = `${NAMESPACE}${FLAT_TOOL_SEPARATOR}list_tools`;
const CALL_TOOL_NAME = `${NAMESPACE}${FLAT_TOOL_SEPARATOR}call_tool`;

const INNER_TOOLS = new Set<FacadeInnerToolName>([
  'memory_write',
  'memory_delete',
  'memory_consolidate',
]);

const RESERVED_KEYS = new Set([
  'invocationId',
  'capability',
  'capabilityMac',
  'facadeOperationId',
  'sessionInstanceId',
  'preparedMemorySessionId',
  'capabilityKind',
  'issuer',
  'nonce',
]);

const WRITE_KEYS = ['type', 'name', 'title', 'description', 'body', 'mode'] as const;
const WRITE_TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const WRITE_MODES = new Set(['create', 'update', 'append']);

export const XDT_WRITE_FORBIDDEN = {
  ok: false,
  code: 'MAKER_MEMORY_NOT_READY',
  message: 'xdt prepared session is read-only; write/delete/consolidate/review are forbidden',
} as const;

const TOOLS: readonly DynamicToolSpec[] = [
  {
    type: 'function',
    name: LIST_TOOLS_NAME,
    description:
      'Discover Host-owned xdt facade mutation tools for this Cindy session. Call list_tools first. Writes remain fail-closed until a later knife.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string', enum: ['write'] },
      },
    },
    deferLoading: false,
  },
  {
    type: 'function',
    name: CALL_TOOL_NAME,
    description:
      'Host-owned xdt facade mutation entry. Pass inner name and arguments. This knife mints a capability and durable retry identity; inner writes still return MAKER_MEMORY_NOT_READY.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'args'],
      properties: {
        name: { type: 'string', minLength: 1 },
        args: { type: 'object', additionalProperties: true },
      },
    },
    deferLoading: false,
  },
];

export interface MemoryFacadeDynamicToolDeps {
  getOwner: () => RegistryOwnerScope;
  getCapabilitySecret: () => string | Buffer | Promise<string | Buffer>;
  getPreparedBySessionId: (sessionId: string) => PreparedMemorySession | undefined;
  /** 生产默认 false：1b 不把第二写入口挂进 Codex listTools 快照。测试可开。 */
  advertiseTools?: boolean;
  now?: () => Date;
  randomUuid?: () => string;
}

export class MemoryFacadeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MemoryFacadeError';
    this.code = code;
  }
}

function textResponse(value: unknown, success = true): DynamicToolCallResponse {
  return {
    contentItems: [
      {
        type: 'inputText',
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
    success,
  };
}

function errorResponse(code: string, message: string): DynamicToolCallResponse {
  return textResponse({ ok: false, code, message }, false);
}

function gatewayTool(params: DynamicToolCallParams): 'list_tools' | 'call_tool' | undefined {
  if (params.namespace === null) {
    if (params.tool === LIST_TOOLS_NAME) return 'list_tools';
    if (params.tool === CALL_TOOL_NAME) return 'call_tool';
    return undefined;
  }
  if (params.namespace !== NAMESPACE) return undefined;
  if (params.tool === 'list_tools' || params.tool === 'call_tool') return params.tool;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function containsReserved(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsReserved);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (RESERVED_KEYS.has(key) || key === '_meta') return true;
    if (containsReserved(record[key])) return true;
  }
  return false;
}

function rejectModelReportedIdentity(params: DynamicToolCallParams): MemoryFacadeError | undefined {
  const args = asRecord(params.arguments);
  if (args && containsReserved(args)) {
    return new MemoryFacadeError(
      'INVALID_ARGS',
      'model-reported invocation identity is forbidden',
    );
  }
  const extra = params as DynamicToolCallParams & { _meta?: unknown };
  if (containsReserved(extra._meta)) {
    return new MemoryFacadeError(
      'INVALID_ARGS',
      'model-reported invocation identity is forbidden',
    );
  }
  return undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryFacadeError('INVALID_ARGS', `${field} is required`);
  }
  return value;
}

function normalizeInnerArgs(
  innerName: FacadeInnerToolName,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (containsReserved(raw)) {
    throw new MemoryFacadeError('INVALID_ARGS', 'model-reported invocation identity is forbidden');
  }
  if (innerName === 'memory_write') {
    const extra = Object.keys(raw).filter((key) => !WRITE_KEYS.includes(key as typeof WRITE_KEYS[number]));
    if (extra.length > 0) {
      throw new MemoryFacadeError('INVALID_ARGS', `unknown field: ${extra[0]}`);
    }
    const type = requireString(raw.type, 'type');
    if (!WRITE_TYPES.has(type)) {
      throw new MemoryFacadeError('INVALID_ARGS', 'type must be a curated memory type');
    }
    const mode = raw.mode === undefined ? 'create' : requireString(raw.mode, 'mode');
    if (!WRITE_MODES.has(mode)) {
      throw new MemoryFacadeError('INVALID_ARGS', 'mode must be create, update, or append');
    }
    return {
      type,
      name: requireString(raw.name, 'name'),
      title: requireString(raw.title, 'title'),
      description: requireString(raw.description, 'description'),
      body: requireString(raw.body, 'body'),
      mode,
    };
  }
  if (innerName === 'memory_delete') {
    const extra = Object.keys(raw).filter((key) => key !== 'filename');
    if (extra.length > 0) {
      throw new MemoryFacadeError('INVALID_ARGS', `unknown field: ${extra[0]}`);
    }
    return { filename: requireString(raw.filename, 'filename') };
  }
  const extra = Object.keys(raw).filter((key) => key !== 'sources' && key !== 'target');
  if (extra.length > 0) {
    throw new MemoryFacadeError('INVALID_ARGS', `unknown field: ${extra[0]}`);
  }
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    throw new MemoryFacadeError('INVALID_ARGS', 'sources is required');
  }
  const target = asRecord(raw.target);
  if (!target) {
    throw new MemoryFacadeError('INVALID_ARGS', 'target is required');
  }
  return {
    sources: raw.sources,
    target: normalizeInnerArgs('memory_write', { ...target, mode: 'create' }),
  };
}

function denyWriteResponse(): DynamicToolCallResponse {
  return textResponse(XDT_WRITE_FORBIDDEN, false);
}

function mapCaught(err: unknown): DynamicToolCallResponse {
  if (err instanceof MemoryFacadeError) {
    return errorResponse(err.code, err.message.replace(/^INVALID_ARGS: /, ''));
  }
  if (err instanceof FacadeInvocationLedgerError) {
    return errorResponse(err.code, err.message.replace(/^[A-Z_]+: /, ''));
  }
  if (err instanceof FacadeJournalError) {
    return errorResponse(err.code, err.message.replace(/^[A-Z_]+: /, ''));
  }
  if (err instanceof XdtPrepareError) {
    return errorResponse(err.code, err.message.replace(/^[A-Z_]+: /, ''));
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('JOURNAL_BUSY')) {
    return errorResponse('JOURNAL_BUSY', 'facade journal is busy');
  }
  return errorResponse('INTERNAL', 'host facade call failed');
}

async function reuseOrMint(
  deps: MemoryFacadeDynamicToolDeps,
  owner: RegistryOwnerScope,
  identity: CallIdentity,
  prepared: PreparedMemorySession,
  innerName: FacadeInnerToolName,
  normalizedArgsDigest: string,
): Promise<void> {
  const secret = await deps.getCapabilitySecret();
  const now = freezeUtcZ((deps.now?.() ?? new Date()).toISOString());
  const sessionInstanceId = prepared.nativeMemoryProof.sessionInstanceId;
  const preparedMemorySessionId = prepared.preparedMemorySessionId;
  if (!UUID_V4_RE.test(sessionInstanceId) || !UUID_V4_RE.test(preparedMemorySessionId)) {
    throw new MemoryFacadeError('INVALID_ARGS', 'prepared session ids must be UUID v4');
  }

  const existing = await readInvocationLedger(owner, identity);
  if (!existing) {
    const indexedInvocationId = await readCallIndexInvocationId(owner, identity);
    if (indexedInvocationId) {
      const claimed = await readByInvocation({ owner }, indexedInvocationId);
      if (claimed) {
        throw new FacadeInvocationLedgerError(
          'MUTATION_IDENTITY_UNAVAILABLE',
          'retry ledger missing after claim; do not remint',
        );
      }
    }
  }
  if (existing) {
    if (
      existing.normalizedArgsDigest !== normalizedArgsDigest
      || existing.innerToolName !== innerName
      || existing.sessionInstanceId !== sessionInstanceId
      || existing.preparedMemorySessionId !== preparedMemorySessionId
    ) {
      throw new FacadeInvocationLedgerError(
        'MUTATION_IDENTITY_UNAVAILABLE',
        'ledger identity does not match this call',
      );
    }
    if (existing.facadeOperationId && existing.operationId) {
      return;
    }
    const claimed = await readByInvocation({ owner }, existing.invocationId);
    if (claimed) {
      await fillInvocationLedgerOperationIds(owner, identity, {
        facadeOperationId: claimed.claim.facadeOperationId,
        operationId: claimed.claim.operationId,
      });
      return;
    }
    const capability = mintFacadeInitialCapability(
      {
        innerToolName: innerName,
        normalizedArgsDigest,
        sessionInstanceId,
        preparedMemorySessionId,
        invocationId: existing.invocationId,
      },
      secret,
    );
    if (!verifyFacadeInitialCapability(capability, secret)) {
      throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'capability mac rejected');
    }
    const result = await claimFacadeInvocation({ owner }, {
      capability: { kind: 'FacadeInitialInvocationCapabilityV1', invocationId: capability.invocationId },
    });
    await fillInvocationLedgerOperationIds(owner, identity, {
      facadeOperationId: result.facadeOperationId,
      operationId: result.operationId,
    });
    return;
  }

  const invocationId = (deps.randomUuid ?? randomUUID)();
  const identityRecord: FacadeInvocationLedgerV1 = {
    schemaVersion: 1,
    threadId: identity.threadId,
    turnId: identity.turnId,
    callId: identity.callId,
    invocationId,
    innerToolName: innerName,
    normalizedArgsDigest,
    sessionInstanceId,
    preparedMemorySessionId,
    ownerScopeDigest: ownerScopeDigest(owner.dataOwnerId),
    issuedAt: now,
    facadeOperationId: null,
    operationId: null,
  };
  await writeIdentityLedger(owner, identityRecord);

  const capability = mintFacadeInitialCapability(
    {
      innerToolName: innerName,
      normalizedArgsDigest,
      sessionInstanceId,
      preparedMemorySessionId,
      invocationId,
    },
    secret,
  );
  if (!verifyFacadeInitialCapability(capability, secret)) {
    throw new FacadeInvocationLedgerError('MUTATION_IDENTITY_UNAVAILABLE', 'capability mac rejected');
  }

  try {
    const result = await claimFacadeInvocation({ owner }, {
      capability: { kind: 'FacadeInitialInvocationCapabilityV1', invocationId: capability.invocationId },
    });
    await fillInvocationLedgerOperationIds(owner, identity, {
      facadeOperationId: result.facadeOperationId,
      operationId: result.operationId,
    });
  } catch (err) {
    if (err instanceof FacadeJournalError && err.code === 'JOURNAL_INVALID') {
      const claimed = await readByInvocation({ owner }, invocationId);
      if (claimed) {
        await fillInvocationLedgerOperationIds(owner, identity, {
          facadeOperationId: claimed.claim.facadeOperationId,
          operationId: claimed.claim.operationId,
        });
        return;
      }
    }
    throw err;
  }
}

export function createMemoryFacadeCodexDynamicToolProvider(
  deps: MemoryFacadeDynamicToolDeps,
): CodexHostDynamicToolProvider {
  return {
    listTools: (context: CodexHostDynamicToolContext) => {
      if (deps.advertiseTools !== true) return [];
      if (!context.sessionId) return [];
      return deps.getPreparedBySessionId(context.sessionId) ? TOOLS : [];
    },
    callTool: async (params, context) => {
      const gateway = gatewayTool(params);
      if (!gateway) return undefined;

      if (gateway === 'list_tools') {
        const args = asRecord(params.arguments) ?? {};
        const extra = Object.keys(args).filter((key) => key !== 'category');
        if (extra.length > 0 || (args.category !== undefined && args.category !== 'write')) {
          return errorResponse('INVALID_ARGS', 'list_tools arguments are invalid');
        }
        return textResponse({
          ok: true,
          category: 'write',
          tools: [
            { name: 'memory_write', description: 'Host facade write; currently fail-closed.' },
            { name: 'memory_delete', description: 'Host facade delete; currently fail-closed.' },
            { name: 'memory_consolidate', description: 'Host facade consolidate; currently fail-closed.' },
          ],
        });
      }

      const forbidden = rejectModelReportedIdentity(params);
      if (forbidden) return errorResponse(forbidden.code, forbidden.message.replace(/^INVALID_ARGS: /, ''));

      const envelope = asRecord(params.arguments);
      if (
        !envelope
        || Object.keys(envelope).some((key) => key !== 'name' && key !== 'args')
        || typeof envelope.name !== 'string'
        || !envelope.args
        || typeof envelope.args !== 'object'
        || Array.isArray(envelope.args)
      ) {
        return errorResponse('INVALID_ARGS', 'call_tool requires name and args');
      }
      if (!INNER_TOOLS.has(envelope.name as FacadeInnerToolName)) {
        return errorResponse('INVALID_ARGS', 'inner tool is not a facade mutation');
      }
      const innerName = envelope.name as FacadeInnerToolName;

      try {
        if (!context.sessionId) {
          throw new MemoryFacadeError('INVALID_ARGS', 'Cindy session is unavailable');
        }
        const prepared = deps.getPreparedBySessionId(context.sessionId);
        if (!prepared) {
          throw new MemoryFacadeError(
            'FACADE_CAPABILITY_REQUIRED',
            'prepared xdt session is required before mint',
          );
        }
        const owner = deps.getOwner();
        if (!owner.dataOwnerId || !owner.ownerRoot) {
          throw new MemoryFacadeError('WORKSPACE_IDENTITY_REQUIRED', 'owner scope is required');
        }
        if (owner.ownerRoot.toLowerCase().includes('cindy-no-session')) {
          throw new MemoryFacadeError('WORKSPACE_IDENTITY_REQUIRED', 'journal must not write cindy-no-session');
        }
        const innerArgs = normalizeInnerArgs(innerName, asRecord(envelope.args) ?? {});
        const normalizedArgsDigest = objectDigest(innerArgs);
        const identity: CallIdentity = {
          threadId: params.threadId,
          turnId: params.turnId,
          callId: params.callId,
        };
        await reuseOrMint(deps, owner, identity, prepared, innerName, normalizedArgsDigest);
        return denyWriteResponse();
      } catch (err) {
        return mapCaught(err);
      }
    },
  };
}

export function composeCodexHostDynamicToolProviders(
  providers: readonly CodexHostDynamicToolProvider[],
): CodexHostDynamicToolProvider {
  return {
    listTools: (context) => {
      const tools: DynamicToolSpec[] = [];
      for (const provider of providers) {
        try {
          tools.push(...provider.listTools(context));
        } catch {
          // One provider must not wipe the rest of the Host dynamic tool snapshot.
        }
      }
      return tools;
    },
    callTool: async (params, context) => {
      for (const provider of providers) {
        const response = await provider.callTool(params, context);
        if (response !== undefined) return response;
      }
      return undefined;
    },
  };
}
