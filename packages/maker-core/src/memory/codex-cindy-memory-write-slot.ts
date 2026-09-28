/**
 * Process-local Codex cindy_memory write slot.
 * callId is Host-observed mcpToolCall.id from item/started, never JSON-RPC id
 * and never a Host-minted UUID. Keyed by Cindy sessionInstanceId.
 */

export interface CodexCindyMemoryWriteSlot {
  sessionId: string;
  sessionInstanceId: string;
  itemId: string;
}

const slots = new Map<string, CodexCindyMemoryWriteSlot>();
const occupied = new Set<string>();

function isCindyMemoryWriteCreateOrUpdate(item: unknown): item is {
  id: string;
  type: 'mcpToolCall';
  server: string;
  tool: string;
  arguments: { name: string; args?: { mode?: unknown } };
} {
  if (!item || typeof item !== 'object') return false;
  const rec = item as Record<string, unknown>;
  if (rec.type !== 'mcpToolCall') return false;
  if (typeof rec.id !== 'string' || rec.id.trim().length === 0) return false;
  if (rec.server !== 'cindy_memory') return false;
  if (rec.tool !== 'call_tool') return false;
  const args = rec.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if ((args as { name?: unknown }).name !== 'memory_write') return false;
  const inner = (args as { args?: unknown }).args;
  const mode = inner && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as { mode?: unknown }).mode
    : undefined;
  return mode === undefined || mode === 'create' || mode === 'update';
}

export function rememberCodexCindyMemoryWriteSlot(input: {
  sessionId?: string;
  sessionInstanceId?: string;
  item: unknown;
}): void {
  const sessionId = input.sessionId?.trim();
  const sessionInstanceId = input.sessionInstanceId?.trim();
  if (!sessionId || !sessionInstanceId) return;
  if (!isCindyMemoryWriteCreateOrUpdate(input.item)) return;
  const existing = slots.get(sessionInstanceId);
  if (existing && existing.itemId !== input.item.id) return;
  slots.set(sessionInstanceId, {
    sessionId,
    sessionInstanceId,
    itemId: input.item.id,
  });
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

/**
 * Host-owned occupancy for one HTTP cindy_memory create/update.
 * Peek still returns the unique slot; a second HTTP while occupied must reject.
 */
export function tryAcquireCodexCindyMemoryWriteSlot(input: {
  sessionId?: string;
  sessionInstanceId?: string;
}): CodexCindyMemoryWriteSlot | undefined {
  const sessionId = input.sessionId?.trim();
  const key = input.sessionInstanceId?.trim();
  if (!sessionId || !key) return undefined;
  const slot = slots.get(key);
  if (!slot || slot.sessionId !== sessionId) return undefined;
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
}
