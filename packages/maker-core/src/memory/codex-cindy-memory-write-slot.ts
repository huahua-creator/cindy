/**
 * Process-local Codex cindy_memory write slot.
 * callId is Host-observed mcpToolCall.id from item/started, never JSON-RPC id
 * and never a Host-minted UUID. Keyed by Cindy sessionInstanceId.
 * HTTP acquire must match the same args digest; mismatch refuses, never upserts.
 */

import { createHash } from 'node:crypto';

export interface CodexCindyMemoryWriteSlot {
  sessionId: string;
  sessionInstanceId: string;
  itemId: string;
  argsDigest: string;
}

const WRITE_DIGEST_FIELDS = ['type', 'name', 'title', 'description', 'body', 'mode'] as const;
const WRITE_TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const WRITE_MODES = new Set(['create', 'update']);
export const CODEX_CINDY_MEMORY_WRITE_RESERVED_ARG_KEYS = new Set([
  'invocationId',
  'capability',
  'capabilityMac',
  'facadeOperationId',
  'sessionInstanceId',
  'preparedMemorySessionId',
  'capabilityKind',
  'issuer',
  'nonce',
  'callId',
]);

const slots = new Map<string, CodexCindyMemoryWriteSlot>();
const occupied = new Set<string>();
const bufferedItemIdsByTurn = new Map<string, Set<string>>();

function bufferedTurnKey(sessionInstanceId: string, turnId: string): string {
  return `${sessionInstanceId}\0${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCindyMemoryWriteCreateOrUpdate(item: unknown): item is {
  id: string;
  type: 'mcpToolCall';
  server: string;
  tool: string;
  arguments: { name: string; args?: unknown };
} {
  if (!isRecord(item)) return false;
  if (item.type !== 'mcpToolCall') return false;
  if (typeof item.id !== 'string' || item.id.trim().length === 0) return false;
  if (item.server !== 'cindy_memory') return false;
  if (item.tool !== 'call_tool') return false;
  const args = item.arguments;
  if (!isRecord(args)) return false;
  if (args.name !== 'memory_write') return false;
  const inner = args.args;
  const mode = isRecord(inner) ? inner.mode : undefined;
  return mode === undefined || mode === 'create' || mode === 'update';
}

function hasReservedWriteArgKey(args: Record<string, unknown>): boolean {
  return Object.keys(args).some((key) => CODEX_CINDY_MEMORY_WRITE_RESERVED_ARG_KEYS.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Fixed-field digest for Codex cindy_memory create/update.
 * Field order is type, name, title, description, body, mode.
 * Missing mode is written as create before hashing. JSON key order is ignored.
 */
export function digestCodexCindyMemoryWriteArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  if (hasReservedWriteArgKey(args)) return undefined;
  if (!WRITE_TYPES.has(String(args.type))) return undefined;
  if (!isNonEmptyString(args.name) || !isNonEmptyString(args.title)
    || !isNonEmptyString(args.description) || !isNonEmptyString(args.body)) {
    return undefined;
  }
  const mode = args.mode === undefined ? 'create' : args.mode;
  if (typeof mode !== 'string' || !WRITE_MODES.has(mode)) return undefined;
  const canonical = {
    type: args.type,
    name: args.name,
    title: args.title,
    description: args.description,
    body: args.body,
    mode,
  };
  const json = JSON.stringify(canonical, WRITE_DIGEST_FIELDS as unknown as string[]);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

function writeArgsFromItem(item: {
  arguments: { name: string; args?: unknown };
}): Record<string, unknown> | undefined {
  const inner = item.arguments.args;
  return isRecord(inner) ? inner : undefined;
}

export function rememberCodexCindyMemoryWriteSlot(input: {
  sessionId?: string;
  sessionInstanceId?: string;
  item: unknown;
  turnId?: string;
}): void {
  const sessionId = input.sessionId?.trim();
  const sessionInstanceId = input.sessionInstanceId?.trim();
  if (!sessionId || !sessionInstanceId) return;
  if (!isCindyMemoryWriteCreateOrUpdate(input.item)) return;
  const args = writeArgsFromItem(input.item);
  if (!args) return;
  const argsDigest = digestCodexCindyMemoryWriteArgs(args);
  if (!argsDigest) return;
  const existing = slots.get(sessionInstanceId);
  if (existing && existing.itemId !== input.item.id) return;
  slots.set(sessionInstanceId, {
    sessionId,
    sessionInstanceId,
    itemId: input.item.id,
    argsDigest,
  });
  const turnId = input.turnId?.trim();
  if (turnId) {
    const key = bufferedTurnKey(sessionInstanceId, turnId);
    const ids = bufferedItemIdsByTurn.get(key) ?? new Set<string>();
    ids.add(input.item.id);
    bufferedItemIdsByTurn.set(key, ids);
  }
}

export function peekCodexCindyMemoryWriteSlot(
  sessionInstanceId: string | undefined,
): CodexCindyMemoryWriteSlot | undefined {
  const key = sessionInstanceId?.trim();
  if (!key) return undefined;
  return slots.get(key);
}

export function forgetCodexCindyMemoryWriteSlot(input: {
  sessionInstanceId?: string;
  itemId?: string;
}): void {
  const key = input.sessionInstanceId?.trim();
  const itemId = input.itemId?.trim();
  if (!key || !itemId) return;
  const slot = slots.get(key);
  if (slot?.itemId === itemId) slots.delete(key);
}

export function forgetCodexCindyMemoryWriteSlotsForTurn(input: {
  sessionInstanceId?: string;
  turnId?: string;
}): void {
  const sessionInstanceId = input.sessionInstanceId?.trim();
  const turnId = input.turnId?.trim();
  if (!sessionInstanceId || !turnId) return;
  const key = bufferedTurnKey(sessionInstanceId, turnId);
  const ids = bufferedItemIdsByTurn.get(key);
  bufferedItemIdsByTurn.delete(key);
  if (!ids) return;
  for (const itemId of ids) {
    forgetCodexCindyMemoryWriteSlot({ sessionInstanceId, itemId });
  }
}

/**
 * Host-owned occupancy for one HTTP cindy_memory create/update.
 * Peek still returns the unique slot; a second HTTP while occupied must reject.
 * argsDigest must equal the remembered digest; mismatch refuses and does not upsert.
 */
export function tryAcquireCodexCindyMemoryWriteSlot(input: {
  sessionId?: string;
  sessionInstanceId?: string;
  argsDigest?: string;
}): CodexCindyMemoryWriteSlot | undefined {
  const sessionId = input.sessionId?.trim();
  const key = input.sessionInstanceId?.trim();
  const argsDigest = input.argsDigest?.trim();
  if (!sessionId || !key || !argsDigest) return undefined;
  const slot = slots.get(key);
  if (!slot || slot.sessionId !== sessionId) return undefined;
  if (slot.argsDigest !== argsDigest) return undefined;
  if (occupied.has(key)) return undefined;
  occupied.add(key);
  return slot;
}

export function releaseCodexCindyMemoryWriteSlot(sessionInstanceId?: string): void {
  const key = sessionInstanceId?.trim();
  if (!key) return;
  occupied.delete(key);
}

export function resetCodexCindyMemoryWriteSlotsForTest(): void {
  slots.clear();
  occupied.clear();
  bufferedItemIdsByTurn.clear();
}
