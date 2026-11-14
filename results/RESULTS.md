# RecallPay — executed prototype

Status: **passed**. Completed 2026-11-14T17:31:57.596Z.

Network: Local NEAR Sandbox; nearcore 2.6.2, commit 2f9ddb711ebd94a306eaec06030d87ef8dfc51fa.

- 16 demonstration checks passed.
- Three affected jobs paused; two unrelated jobs completed their next paid action.
- Provider received 0.6 NEAR in sale proceeds before recall.
- Buyers received 0.4 NEAR in native-token refunds in separate wallets.
- Expected stale-client payment and duplicate-refund attempts were rejected.

## Limits

- Provider-declared recalls only. Data truth is not automatically verified.
- Coverage refunds the purchase fee; gas and storage fees are excluded.
- Only participating jobs with complete declared dependencies can be paused.
- A recall cannot undo actions authorized before it, external transactions, or delivered work.
- Native NEAR only. No crosschain or confidential execution integration is claimed.
- A failed withdrawal callback can leave a pending operation; no timeout-based release is provided.
- Prototype has no production audit or demand validation.

## Evidence

Machine-readable transaction hashes, events, balances and checks: [demo.json](demo.json). Visual report: [demo.html](demo.html).

This demonstrates the mechanism on synthetic data. It does not establish customer demand or global novelty.
