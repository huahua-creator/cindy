import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sub2apiBudgetMutation as mutate } from '../sub2apiBudgetTx';
import type { BudgetAttempt } from '../../../../../shared/sub2apiBudget';

const uuid = 'dd0d39a6-9dfd-493b-a4e2-bc6f95dd9a98';
const binding = {
  id: uuid,
  ownerId: 'u',
  sessionId: 's',
  providerId: 'p',
  responsesUrl: 'https://example.test/v1/responses',
  credentialGeneration: 'a'.repeat(64),
};
const expected = { ...binding, clientRequestId: uuid };
let db: Database.Database;
function row(id = uuid): BudgetAttempt {
  return {
    id,
    owner_id: 'u',
    session_id: 's',
    provider_id: 'p',
    responses_url: binding.responsesUrl,
    credential_generation: binding.credentialGeneration,
    client_request_id: uuid,
    response_id: null,
    message_client_id: null,
    state: 'pending',
    amount: null,
    attempts: 0,
    created_at: 1,
    updated_at: 1,
  };
}
function message(clientId = 'm', rid = 'resp_1') {
  db.prepare(
    "INSERT INTO messages(session_id,client_id,role,agent_meta,created_at) VALUES('s',?,'assistant',?,2)",
  ).run(clientId, JSON.stringify({ requestId: rid, turnCostUsd: 0.49253 }));
}
function meta(clientId = 'm') {
  return JSON.parse(
    (
      db.prepare('SELECT agent_meta FROM messages WHERE client_id=?').get(clientId) as {
        agent_meta: string;
      }
    ).agent_meta,
  );
}
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,cleared_at INTEGER);CREATE TABLE messages(session_id TEXT,client_id TEXT,role TEXT,agent_meta TEXT,created_at INTEGER,rewind_at INTEGER);INSERT INTO sessions(id) VALUES('s');",
  );
  db.exec(
    readFileSync(
      resolve(__dirname, '../../../../../../drizzle/0123_sub2api_budget_requests.sql'),
      'utf8',
    ),
  );
  db.exec(
    readFileSync(
      resolve(__dirname, '../../../../../../drizzle/0124_sub2api_budget_watermark.sql'),
      'utf8',
    ),
  );
});
afterEach(() => db.close());
describe('budget identity and atomic message projection', () => {
  it('binds once to the first new block when several blocks precede the hook', () => {
    message('old');
    db.exec("UPDATE messages SET created_at=1 WHERE client_id='old'");
    mutate(db, { action: 'observe', row: row() });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message('first');
    message('second');
    db.exec('UPDATE messages SET created_at=1');
    expect(mutate(db, { action: 'link', ...binding, clientId: 'second' }).messageClientId).toBe(
      'first',
    );
    mutate(db, { action: 'link', ...binding, clientId: 'first' });
    mutate(db, {
      action: 'settle',
      ownerId: 'u',
      id: uuid,
      state: 'complete',
      amount: '0.98506000',
      expected,
    });
    expect(meta('first').sub2apiBudget.state).toBe('complete');
    expect(meta('second').sub2apiBudget).toBeUndefined();
    expect(meta('old').sub2apiBudget).toBeUndefined();
  });
  it('relinks an observed request after the in-memory binding is lost', () => {
    mutate(db, { action: 'observe', row: row() });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message();
    expect(mutate(db, { action: 'link', ...binding }).messageClientId).toBe('m');
  });
  it('bounds cleanup and preserves projected amounts and other owners', () => {
    const old = row();
    mutate(db, { action: 'observe', row: old });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message();
    mutate(db, { action: 'link', ...binding });
    const insert = db.prepare(`INSERT INTO sub2api_budget_requests
      (id,owner_id,session_id,provider_id,responses_url,credential_generation,state,created_at,updated_at)
      VALUES(? ,?,'s','p','url','gen','unavailable',0,0)`);
    for (let i = 0; i < 120; i++) insert.run(`old-${i}`, 'u');
    insert.run('other', 'other');
    mutate(db, { action: 'cleanup', ownerId: 'u', now: 32 * 86400000 });
    expect(
      (db.prepare("SELECT COUNT(*) n FROM sub2api_budget_requests WHERE owner_id='u'").get() as any)
        .n,
    ).toBe(21);
    mutate(db, { action: 'cleanup', ownerId: 'u', now: 32 * 86400000 });
    expect((db.prepare('SELECT COUNT(*) n FROM sub2api_budget_requests').get() as any).n).toBe(1);
    expect(meta().sub2apiBudget).toEqual({ state: 'unavailable' });
  });
  it('rejects a settlement with a different frozen binding', () => {
    mutate(db, { action: 'observe', row: row() });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message();
    mutate(db, { action: 'link', ...binding, clientId: 'm' });
    for (const changed of [
      undefined,
      { ...expected, credentialGeneration: 'b'.repeat(64) },
      { ...expected, clientRequestId: 'other' },
    ]) {
      expect(
        mutate(db, {
          action: 'settle',
          ownerId: 'u',
          id: uuid,
          state: 'complete',
          amount: '0.98506000',
          expected: changed,
        }),
      ).toEqual({});
    }
    expect(meta().sub2apiBudget.state).toBe('pending');
  });
  it('binds one exact request and preserves SDK metadata', () => {
    mutate(db, { action: 'observe', row: row() });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message();
    mutate(db, { action: 'link', ...binding, clientId: 'm' });
    expect(meta().sub2apiBudget.state).toBe('pending');
    mutate(db, {
      action: 'settle',
      ownerId: 'u',
      id: uuid,
      state: 'complete',
      amount: '0.98506000',
      expected,
    });
    expect(meta()).toMatchObject({
      turnCostUsd: 0.49253,
      sub2apiBudget: { state: 'complete', amount: '0.98506000' },
    });
    mutate(db, {
      action: 'settle',
      ownerId: 'u',
      id: uuid,
      state: 'complete',
      amount: '9.00000000',
      expected,
    });
    expect(meta().sub2apiBudget.amount).toBe('0.98506000');
    message('second');
    mutate(db, { action: 'link', ...binding, clientId: 'second' });
    expect(meta('second').sub2apiBudget).toBeUndefined();
  });
  it('refuses owner, origin, provider or key-generation mismatches', () => {
    mutate(db, { action: 'observe', row: row() });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message();
    for (const patch of [
      { ownerId: 'other' },
      { providerId: 'other' },
      { responsesUrl: 'https://other.test/v1/responses' },
      { credentialGeneration: 'b'.repeat(64) },
    ]) {
      expect(mutate(db, { action: 'link', ...binding, ...patch, clientId: 'm' })).toEqual({});
    }
    expect(meta().sub2apiBudget).toBeUndefined();
  });
  it('does not bind a cleared or rewound message', () => {
    mutate(db, { action: 'observe', row: row() });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message();
    db.exec('UPDATE sessions SET cleared_at=3');
    expect(mutate(db, { action: 'link', ...binding, clientId: 'm' })).toEqual({});
    db.exec('UPDATE sessions SET cleared_at=NULL;UPDATE messages SET rewind_at=3');
    expect(mutate(db, { action: 'link', ...binding, clientId: 'm' })).toEqual({});
  });
  it('does not guess when the provider reused a response id', () => {
    const second = 'ad0d39a6-9dfd-493b-a4e2-bc6f95dd9a98';
    for (const r of [row(), { ...row(second), client_request_id: second }]) {
      mutate(db, { action: 'observe', row: r });
      mutate(db, { action: 'identify', ownerId: 'u', id: r.id, responseId: 'resp_1' });
    }
    message();
    expect(mutate(db, { action: 'link', ...binding, clientId: 'm' })).toEqual({});
  });
  it('accepts a verified zero and rejects invalid decimal without overwriting state', () => {
    mutate(db, { action: 'observe', row: row() });
    mutate(db, { action: 'identify', ownerId: 'u', id: uuid, responseId: 'resp_1' });
    message();
    mutate(db, { action: 'link', ...binding, clientId: 'm' });
    expect(() =>
      mutate(db, { action: 'settle', ownerId: 'u', id: uuid, state: 'complete', amount: 'NaN' }),
    ).toThrow();
    expect(meta().sub2apiBudget.state).toBe('pending');
    mutate(db, {
      action: 'settle',
      ownerId: 'u',
      id: uuid,
      state: 'complete',
      amount: '0.00000000',
      expected,
    });
    expect(meta().sub2apiBudget.amount).toBe('0.00000000');
  });
  it('deduplicates observed receipts across credential generations and caps recovery', () => {
    mutate(db, { action: 'observe', row: row() });
    expect(
      mutate(db, {
        action: 'observe',
        row: {
          ...row('ad0d39a6-9dfd-493b-a4e2-bc6f95dd9a98'),
          credential_generation: 'b'.repeat(64),
        },
      }),
    ).toEqual({});
    for (let i = 0; i < 6; i++)
      expect(mutate(db, { action: 'attempt', ownerId: 'u', id: uuid }).allowed).toBe(true);
    expect(mutate(db, { action: 'attempt', ownerId: 'u', id: uuid }).allowed).toBe(false);
  });
});
