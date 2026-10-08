# Claude SDK third-party cost estimates

## Scope

The user's custom Cindy fork must not label a Claude SDK estimate for a
non-Anthropic model as an actual provider bill. Preserve its amount and currency,
do not multiply it to match a separate gateway, and do not rewrite historical
messages or ledgers. No upstream public-repository changes or deployment.

The observed Astra turn had 98,476 input tokens, six output tokens and an SDK
amount of USD0.49253. A separate gateway recorded USD0.98506. These are distinct
money sources; this patch does not connect or reconcile the gateway ledger.

## Implementation

- Both per-model and cumulative-only Claude paths classify non-Anthropic SDK
  amounts as value-estimate, approximate=true. Message/scheduler estimate flags
  remain intact; actual daily/session/model spend excludes these estimates.
- Preserve native Claude behavior and existing subscription, managed, reference
  pricing and XD gateway precedence. Explicit sdkSource limits the shared
  calculator change to Claude; Pi retains its existing behavior.
- Reuse existing model normalization and currency conversion. Do not invent a
  reference-price or subscription-value reason for an SDK amount.
- Reject nonpositive/nonfinite amounts. The first cumulative observation still
  establishes a baseline rather than charging historical process spend.
- Existing mixed-turn presentation prioritizes actual money; separate display
  of its estimated portion remains outside this patch.

## Review and tests

Feynman (01a11919-9b3d-7772-87ad-7e3290eb2dad) reviewed the plan before changes:
GO, requiring both paths, source isolation, invalid-number coverage, and no
misleading estimate reason. All requirements were addressed. Final actual-code
review: GO; reviewer independently ran 96 tests and diff-check. After disclosure
of the baseline typecheck failure, reviewer accepted local-source delivery only,
without packaging/deployment. No production database writes or app restart.

Main-agent verification: 147/147 tests passed across turnCostCalculator,
claudeSdkCostFallback, makerEventHotPathOrdering, turnCostBroadcaster and
regionalMoney, using vitest with one worker. The fallback test executes the real
production dispatch block with mocked persistence; it is not an Electron
end-to-end test. git diff --check passed.

Full desktop `pnpm typecheck` failed (exit2):
`src/main/mcp-integrations/browser-real-profile/snapshot.ts(260,20): TS2304 Cannot find name 'DatabaseSync'`.
That unmodified file belongs to the pre-existing e0041fc08 commit. It was not
changed to hide the failure. No claim of a green whole-repository typecheck.

Only the custom fork huahua-creator/cindy may receive this work. Existing
installed binaries and historical amounts remain unchanged. Exact gateway
budget display still requires a separately reviewed request-ID and authorized
per-key usage-query integration.
