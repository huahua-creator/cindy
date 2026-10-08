import { describe, expect, it } from 'vitest';
import {
  normalizeBudgetURL,
  readBudgetJSON,
  responseIdentityParser,
  validateBudgetReceipt,
} from '../sub2api-budget-protocol';
const id = 'dd0d39a6-9dfd-493b-a4e2-bc6f95dd9a98';
describe('Sub2API budget protocol', () => {
  it('pins only secure or explicit loopback Responses endpoints', () => {
    expect(normalizeBudgetURL('http://127.0.0.1:18080/v1/responses')).toBeTruthy();
    for (const u of [
      'http://example.com/v1/responses',
      'https://user:secret@example.com/v1/responses',
      'https://a/v1/responses?x=1',
      'https://a/responses',
      'file:///v1/responses',
    ])
      expect(normalizeBudgetURL(u)).toBeNull();
  });
  it('strictly validates receipt identity, precision and non-cash kind', () => {
    const r = {
      schema_version: 1,
      kind: 'subscription-budget',
      currency: 'USD',
      amount: '0.98506000',
      client_request_id: id,
      settled_at: new Date().toISOString(),
    };
    expect(validateBudgetReceipt(r, id)).toBe(r.amount);
    for (const p of [
      { schema_version: 2 },
      { kind: 'actual-cost' },
      { amount: 0.98506 },
      { amount: 'NaN' },
      { amount: '-1.00000000' },
      { amount: '0.98' },
      { currency: 'CNY' },
      { client_request_id: 'other' },
      { settled_at: 'invalid' },
    ])
      expect(validateBudgetReceipt({ ...r, ...p }, id)).toBeNull();
  });
  it('reads a split CRLF SSE identity without retaining body text', async () => {
    const got: string[] = [];
    const feed = responseIdentityParser(async (x) => {
      got.push(x);
    });
    const text =
      'data: ' +
      JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }) +
      '\r\n\r\n';
    for (const ch of text) await feed(new TextEncoder().encode(ch));
    await feed(new TextEncoder().encode(text));
    expect(got).toEqual(['resp_1']);
  });
  it('ignores malformed and oversized identity frames', async () => {
    const got: string[] = [];
    const feed = responseIdentityParser(async (x) => {
      got.push(x);
    });
    await feed(new TextEncoder().encode('data: bad\n\n' + 'x'.repeat(262145)));
    expect(got).toEqual([]);
  });
  it('bounds receipt responses', async () => {
    await expect(readBudgetJSON(new Response('x'.repeat(16385)))).rejects.toThrow();
    expect(await readBudgetJSON(new Response('{"schema_version":1}'))).toEqual({
      schema_version: 1,
    });
  });
});
