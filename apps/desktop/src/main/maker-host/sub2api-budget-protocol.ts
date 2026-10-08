import { budgetDecimal, budgetUUID } from '../../shared/sub2apiBudget.js';

export function normalizeBudgetURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/v1/responses')
      return null;
    if (
      u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}

export function validateBudgetReceipt(value: unknown, id: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    v.schema_version !== 1 ||
    v.kind !== 'subscription-budget' ||
    v.currency !== 'USD' ||
    !budgetUUID(id) ||
    v.client_request_id !== id ||
    !budgetDecimal(v.amount) ||
    typeof v.settled_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT/.test(v.settled_at) ||
    !Number.isFinite(Date.parse(v.settled_at)) ||
    Date.parse(v.settled_at) > Date.now() + 300_000
  )
    return null;
  return v.amount;
}

/** Observes only bounded identity frames; never retains model text or tool arguments. */
export function responseIdentityParser(onIdentity: (id: string) => Promise<void>) {
  let text = '';
  let finished = false;
  const decoder = new TextDecoder();
  return async (chunk: Uint8Array) => {
    if (finished) return;
    if (text.length + chunk.byteLength > 262144) {
      finished = true;
      text = '';
      return;
    }
    text += decoder.decode(chunk, { stream: true });
    // Large frames disable observation only; the caller forwards the original bytes.
    if (text.length > 262144) {
      finished = true;
      text = '';
      return;
    }
    for (;;) {
      const match = /\r?\n\r?\n/.exec(text);
      if (!match) return;
      const frame = text.slice(0, match.index);
      text = text.slice(match.index + match[0].length);
      const payload = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      try {
        const event = JSON.parse(payload);
        if (
          ['response.created', 'response.completed'].includes(event?.type) &&
          typeof event.response?.id === 'string' &&
          /^[A-Za-z0-9_-]{1,200}$/.test(event.response.id)
        ) {
          finished = true;
          text = '';
          await onIdentity(event.response.id);
          return;
        }
      } catch {
        /* A non-identity frame cannot change the model stream. */
      }
    }
  };
}

export async function readBudgetJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty budget receipt');
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > 16384) throw new Error('oversized budget receipt');
      text += decoder.decode(r.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
