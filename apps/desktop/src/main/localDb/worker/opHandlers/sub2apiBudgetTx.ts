import type Database from 'better-sqlite3';
import {
  budgetDecimal,
  budgetUUID,
  type BudgetAttempt,
  type BudgetMutation,
  type BudgetMutationResult,
} from '../../../../shared/sub2apiBudget.js';

export function sub2apiBudgetMutation(db: Database.Database, arg: unknown): BudgetMutationResult {
  const a = arg as BudgetMutation;
  if (!a || typeof a !== 'object') throw new Error('Invalid budget mutation');
  return db.transaction((): BudgetMutationResult => {
    if (a.action === 'observe') {
      const r = a.row;
      if (
        !r ||
        !budgetUUID(r.id) ||
        !r.owner_id ||
        !r.session_id ||
        !r.provider_id ||
        !/^[a-f0-9]{64}$/.test(r.credential_generation) ||
        (r.client_request_id !== null && !budgetUUID(r.client_request_id))
      )
        throw new Error('Invalid budget attempt');
      if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(r.session_id)) return {};
      db.prepare(
        `INSERT INTO sub2api_budget_requests
        (id,owner_id,session_id,provider_id,responses_url,credential_generation,client_request_id,state,created_at,updated_at,observed_message_rowid)
        VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(rowid),0) FROM messages)) ON CONFLICT DO NOTHING`,
      ).run(
        r.id,
        r.owner_id,
        r.session_id,
        r.provider_id,
        r.responses_url,
        r.credential_generation,
        r.client_request_id,
        r.client_request_id ? 'pending' : 'unavailable',
        r.created_at,
        r.updated_at,
      );
      const found = db.prepare('SELECT * FROM sub2api_budget_requests WHERE id=?').get(r.id) as
        BudgetAttempt | undefined;
      return found ? { id: found.id } : {};
    }
    if (!a.ownerId) throw new Error('Missing budget owner');
    if (a.action === 'cleanup') {
      if (!Number.isSafeInteger(a.now) || a.now < 0) return {};
      const old = db
        .prepare(
          `SELECT id,session_id,message_client_id,state FROM sub2api_budget_requests
        WHERE owner_id=? AND (created_at<? OR (message_client_id IS NULL AND created_at<?))
        ORDER BY created_at LIMIT 100`,
        )
        .all(a.ownerId, a.now - 31 * 86400000, a.now - 86400000) as BudgetAttempt[];
      for (const r of old) {
        if (r.state === 'pending' && r.message_client_id) {
          db.prepare(
            `UPDATE messages SET agent_meta=json_set(agent_meta,'$.sub2apiBudget',json('{"state":"unavailable"}'))
            WHERE session_id=? AND client_id=? AND json_valid(agent_meta) AND json_type(agent_meta)='object'`,
          ).run(r.session_id, r.message_client_id);
        }
        db.prepare('DELETE FROM sub2api_budget_requests WHERE owner_id=? AND id=?').run(
          a.ownerId,
          r.id,
        );
      }
      return {};
    }
    if (a.action === 'identify') {
      if (!a.responseId || a.responseId.length > 200) throw new Error('Invalid response identity');
      const changed = db
        .prepare(
          `UPDATE sub2api_budget_requests SET response_id=?,updated_at=? WHERE id=? AND owner_id=? AND response_id IS NULL`,
        )
        .run(a.responseId, Date.now(), a.id, a.ownerId);
      return changed.changes ? { id: a.id } : {};
    }
    let row: BudgetAttempt | undefined;
    if (a.action === 'link') {
      row = db
        .prepare(
          `SELECT * FROM sub2api_budget_requests WHERE id=? AND owner_id=? AND session_id=?
        AND provider_id=? AND responses_url=? AND credential_generation=?`,
        )
        .get(a.id, a.ownerId, a.sessionId, a.providerId, a.responsesUrl, a.credentialGeneration) as
        BudgetAttempt | undefined;
      if (!row?.response_id || row.observed_message_rowid == null || row.observed_message_rowid < 0)
        return {};
      if (a.clientId) {
        const msg = db
          .prepare(
            `SELECT m.agent_meta FROM messages m JOIN sessions s ON s.id=m.session_id
          WHERE m.session_id=? AND m.client_id=? AND m.role='assistant' AND m.rewind_at IS NULL
          AND (s.cleared_at IS NULL OR m.created_at>s.cleared_at)`,
          )
          .get(a.sessionId, a.clientId) as { agent_meta: string | null } | undefined;
        let rid: unknown;
        try {
          rid = JSON.parse(msg?.agent_meta ?? '{}').requestId;
        } catch {
          return {};
        }
        if (typeof rid !== 'string' || rid !== row.response_id) return {};
      }
      const candidates = db
        .prepare(
          'SELECT * FROM sub2api_budget_requests WHERE owner_id=? AND session_id=? AND provider_id=? AND responses_url=? AND credential_generation=? AND response_id=? LIMIT 2',
        )
        .all(
          a.ownerId,
          a.sessionId,
          a.providerId,
          a.responsesUrl,
          a.credentialGeneration,
          row.response_id,
        ) as BudgetAttempt[];
      if (candidates.length !== 1 || candidates[0].id !== a.id) return {};
      row = candidates[0];
      if (!row || !row.response_id) return {};
      const messages = db
        .prepare(
          `SELECT m.client_id,m.agent_meta FROM messages m JOIN sessions s ON s.id=m.session_id
        WHERE m.session_id=? AND m.role='assistant' AND m.rewind_at IS NULL
        AND (s.cleared_at IS NULL OR m.created_at>s.cleared_at)
        AND m.created_at>=? AND m.rowid>?
        AND json_extract(CASE WHEN json_valid(m.agent_meta) THEN m.agent_meta ELSE '{}' END,'$.requestId')=?
        ORDER BY m.created_at,m.rowid LIMIT 1`,
        )
        .all(row.session_id, row.created_at, row.observed_message_rowid, row.response_id) as Array<{
        client_id: string;
        agent_meta: string;
      }>;
      if (row.message_client_id)
        return { id: row.id, messageClientId: row.message_client_id, sessionId: row.session_id };
      if (messages.length !== 1) return {};
      db.prepare(
        'UPDATE sub2api_budget_requests SET message_client_id=?,updated_at=? WHERE id=? AND owner_id=? AND message_client_id IS NULL',
      ).run(messages[0].client_id, Date.now(), row.id, a.ownerId);
      row = { ...row, message_client_id: messages[0].client_id };
    } else {
      row = db
        .prepare('SELECT * FROM sub2api_budget_requests WHERE id=? AND owner_id=?')
        .get(a.id, a.ownerId) as BudgetAttempt | undefined;
      if (!row) return {};
      if (a.action === 'attempt') {
        if (row.state !== 'pending' || row.attempts >= 6) return { allowed: false };
        db.prepare(
          'UPDATE sub2api_budget_requests SET attempts=attempts+1,updated_at=? WHERE id=? AND owner_id=?',
        ).run(Date.now(), row.id, a.ownerId);
        return { allowed: true };
      }
      if (a.action !== 'settle' || row.state === 'complete') return {};
      if (a.state === 'complete' && !budgetDecimal(a.amount))
        throw new Error('Invalid receipt amount');
      if (
        a.state === 'complete' &&
        (!a.expected ||
          a.expected.sessionId !== row.session_id ||
          a.expected.providerId !== row.provider_id ||
          a.expected.responsesUrl !== row.responses_url ||
          a.expected.credentialGeneration !== row.credential_generation ||
          a.expected.clientRequestId !== row.client_request_id)
      )
        return {};
      db.prepare(
        'UPDATE sub2api_budget_requests SET state=?,amount=?,updated_at=? WHERE id=? AND owner_id=?',
      ).run(a.state, a.amount ?? null, Date.now(), row.id, a.ownerId);
      row = { ...row, state: a.state, amount: a.amount ?? null };
    }
    if (!row.message_client_id) return { id: row.id };
    const message = db
      .prepare(
        `SELECT m.agent_meta FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.session_id=? AND m.client_id=? AND m.rewind_at IS NULL
      AND (s.cleared_at IS NULL OR m.created_at>s.cleared_at)`,
      )
      .get(row.session_id, row.message_client_id) as { agent_meta: string | null } | undefined;
    if (!message) return {};
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(message.agent_meta ?? '{}');
    } catch {
      return {};
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
    const budget = {
      state: row.state,
      ...(row.state === 'complete' && row.amount ? { amount: row.amount } : {}),
    };
    db.prepare('UPDATE messages SET agent_meta=? WHERE session_id=? AND client_id=?').run(
      JSON.stringify({ ...meta, sub2apiBudget: budget }),
      row.session_id,
      row.message_client_id,
    );
    return { id: row.id, sessionId: row.session_id, messageClientId: row.message_client_id };
  })();
}
