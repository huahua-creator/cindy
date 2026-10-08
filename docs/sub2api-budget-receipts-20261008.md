# Optional Sub2API request-budget receipts

This private-fork integration observes explicitly pinned custom API-key
Claude Code Responses connections. It does not change original response bytes,
provider response IDs, SDK estimates, native OAuth routing or public providers.
It does not modify the official Cindy repository.

An owner-scoped `sub2api-budget-connections.json` file opts in exact provider IDs
and Responses URLs. It contains no credential. Disabled is the default.
Credentials remain in the existing main-process secret store. A ciphertext
generation fingerprint, owner/profile snapshot and route revision isolate
requests; renderer metadata receives only pending/complete/unavailable and a
validated decimal amount. The amount is one request's committed local
subscription budget, not cash and not a whole agent turn.

The server-generated client UUID and unchanged upstream response ID connect an
observed request to its first new assistant block. Migration 0123 stores request
observations; generated migration 0124 adds the observation-time message rowid
watermark. Timestamp plus rowid prevents same-millisecond historical binding.
Duplicate provider response IDs remain ambiguous and are not guessed.

Restart recovery can deterministically relink already-observed requests after
the message-commit/binding crash window. Per pass: up to 50 pending requests,
30 seconds overall, 3 seconds/16 KiB per lookup, at most six persisted attempts.
Canceled, failed, non-SSE and identity-less streams become unavailable; original
stream behavior remains intact. Cleanup processes at most 100 owner-scoped rows
per pass: unbound observations after one day, all observations after 31 days.
Verified amounts already projected to messages remain; pending projections become
unavailable. Cleanup does not delete messages or change SDK metadata.

## Review and verification

Original independent design review: Feynman
`01a11919-9b3d-7772-87ad-7e3290eb2dad`.
Final actual-code reviewer: Ohm `01a11c19-ae1b-7bd3-bf48-e2db24187f0b`, explicitly
spawned with `gpt-5.6-sol`, reasoning `medium` through the existing native tool.

Closed findings:
- Revalidate the full connection binding inside queued settlement work and check
  the persisted expected binding in the transaction.
- Bind multiple blocks to the deterministic first new message; display a
  separate budget badge on nonfinal blocks without duplicate action bars.
- Persist a rowid watermark to distinguish pre-existing same-millisecond rows.
- Recover crash-window links and bound the orphan/terminal observation lifetime.

Final review: no remaining P0/P1. Reviewer independently reran 25 host/transaction
tests and migration validation. Main verification: 76 focused tests pass across
protocol, host, transaction, message components, store hydration and real SQLite
migration replay; typecheck, db:validate (0000..0124), and i18n consistency pass.
Existing i18n warnings and store-test mock warnings remain, not hidden.

Residual: cleanup does not broadcast every expired pending projection; an
extremely long-lived renderer can show stale pending until reload. Formal
profile migration, live receipt acceptance, packaged installation and real
process-crash validation are not implied by unit/restart simulations.

Rollback should first disable this optional connection integration. Preserve
the previous custom package and user data; do not downgrade or rewrite historical
migrations. Do not use a public stock application as the rollback package.
