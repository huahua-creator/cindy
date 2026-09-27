/**
 * JSON-RPC id → ledger callId。缺/空/非有限整数 → undefined（write.ts:55 红）。
 * 0 是合法 id，归一成 "0"。不扫描 extra._meta（progressToken 不是模型伪造）。
 */

export function normalizeMcpRequestId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}
