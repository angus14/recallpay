# RecallPay

**Bad data was sold. What happens to the agent jobs that used it?** RecallPay
lets a provider recall the exact data version, pauses participating jobs that
depend on it, blocks their next gated payment, and refunds protected purchases
from a reserve funded before the sale.

**Status:** hackathon prototype for a local NEAR blockchain. Native NEAR only.
Two scripted buyer agents use synthetic inventory and shipping data. No model,
mainnet funds, customer data, or Daybreak access is needed.

## Judge in one command

On Linux x64 or macOS Apple Silicon with Node.js 20+ and npm, run:

```bash
bash run.sh
```

The command installs locked dependencies, runs the integration tests on a
local NEAR blockchain, then runs the full customer story. It does not use
mainnet or require keys. Expect `# fail 0` from the tests and this final line:

```text
PASS: 16 checks. 3 jobs paused, 2 continued, 0.4 NEAR refunded.
```

Open `results/demo.html` to inspect the 17 transactions, their hashes and
events, the intentionally rejected stale payment and duplicate claim, and the
buyer wallet balance changes. `results/demo.json` is machine-readable. On a
cold machine the installer downloads the pinned local NEAR sandbox binary.
Where that download is blocked but the exact pinned binary is already present,
set `NEAR_SANDBOX_BIN_PATH` to its path before running `bash run.sh`; the
runner verifies its SHA-256 before use.

## Run the steps separately

Requirements: Node.js 20+, npm, Linux x64 or macOS Apple Silicon. On Linux
containers whose hard file-descriptor limit is below 65,535, a C compiler is
also needed for the included compatibility wrapper. Windows: use WSL or
Codespaces. The sandbox binary is downloaded by the npm dependency installer.

```bash
npm ci --no-audit --no-fund
npm test
npm run demo
```

A checksum-verified `artifacts/recallpay.wasm` is included, so Rust is optional
for running the demonstration.

The demo automatically saves:

- `results/demo.json`: real local transaction hashes, events, checks and balances.
- `results/demo.html`: standalone visual evidence report; open it in a browser.
- `results/RESULTS.md`: concise results and limitations.
- `results/test-run.log`: full integration test output from `bash run.sh`.

For the captioned, explicitly labeled replay video, install Python Pillow and
FFmpeg and run `python3 scripts/render-video.py` after the demo. It reads the
newly generated JSON and writes `RecallPay_demo.mp4`.

Expect the demo to show **three paused jobs, two independent paid actions,
and 0.4 NEAR received as refunds**. The provider withdraws its 0.6 NEAR in sale
proceeds *before* the recall, demonstrating the separate reserve.
Two rejected transactions are intentional: a stale-client payment and a
duplicate refund claim. Unexpected failures make the run exit nonzero.

## Build from source

Install Rust through [rustup](https://rustup.rs/). The repository pins Rust
1.86.0 and the WASM target in `rust-toolchain.toml`, and commits both dependency
lockfiles. Run from the project root:

```bash
npm run build
npm test
npm run demo
```

The build writes the WASM artifact and its manifest. Never regenerate lockfiles
as a routine installation step. The pinned `serde_with` 3.12.0 dependency keeps
this SDK build compatible with the Rust toolchain and sandbox runtime.
The build also runs pinned Binaryen 123 to optimize and normalize the WASM for
the sandbox, including lowering sign-extension instructions.

## Demonstration story

1. A warehouse data provider publishes two immutable data versions, each
   identified by the SHA-256 digest of its exact bytes.
2. It deposits 1 NEAR into a refund reserve.
3. Alice and Bob each buy inventory for 0.2 NEAR and shipping data for 0.1 NEAR.
   Each sale locks a matching amount of the provider's existing reserve.
4. The provider withdraws its sale proceeds to a separate account.
5. The provider corrects a stock count from 80 to 8 and recalls the inventory.
6. Both research jobs and a derived procurement job pause. Two unrelated
   shipping jobs remain ready and complete their next paid action.
7. Even a stale client attempting a protected payment is rejected by the
   contract. A keeper claims refunds; each buyer withdraws 0.2 NEAR to its wallet.
8. A repeated refund attempt is rejected. Remaining liabilities stay backed.

## Core rules

- A protected sale is accepted only if the provider's **free reserve already
  covers the full price**. Purchase proceeds never substitute for that reserve.
- Price, data digest and coverage duration cannot be edited after publication.
- Only the contract account may initialize it. The local deployment then removes
  its access key and verifies the empty key list; this contract exposes no code
  upgrade or account-deletion method. Never do this to an existing user account.
- A recall is authenticated by the publishing provider's NEAR transaction.
- Any keeper can claim, but the original receipt fixes the beneficiary.
- A timely recall remains refundable even if the buyer claims after expiry.
- Expired coverage can release reserves only if no timely recall occurred.
- Spending checks and the recipient credit commit together in one contract
  receipt. A prior recall rejects that action, including with a stale client.
- Withdrawals debit credit before transfer; a definitive transfer failure
  restores it. Pending withdrawals cannot be withdrawn again.
- Storage is charged separately; excess attached deposits become withdrawable
  credit. Transaction gas and storage fees are outside purchase-fee coverage.

After all withdrawal callbacks settle:

```
free reserve + locked reserve + withdrawable credits
    <= contract balance available after storage staking
```

The deployment's separate 10 NEAR operating float pays for initial state and
temporary withdrawal records. It is not counted as the provider's reserve.

## Small SDK integration

```js
import { BuyerAgent, digest, NEAR } from './sdk/index.mjs';
const agent = new BuyerAgent(buyerAccount, recallPayContract);
const versionId = digest(downloadedBytes);
await agent.buy(versionId, 'inventory', downloadedBytes);
agent.addJob('research', { receipts: ['inventory'] });
agent.addJob('procurement', { parents: ['research'] });
const outcome = await agent.payNextAction('procurement', processorAccount, NEAR / 100n);
// outcome.blocked is true if a dependency has been recalled.
```

The SDK accepts near-workspaces account objects. A production wallet adapter
and deployed-service integrations are not implemented.

## Boundaries

This is provider-declared correction handling, not an automated truth oracle.
A provider can fail to acknowledge an error. One prefunded reserve per receipt
is capital-intensive, and its commercial terms need customer validation.

The agent graph is application-supplied. Protection requires complete declared
dependencies and routing the next payment through the contract. A buyer can
omit an input; this prototype does not prove complete provenance. A recall
ordered after payment authorization cannot undo that action. External payments,
completed work and consequential losses are outside scope.

Private data execution, crosschain payouts, automated dispute resolution,
production wallet adapters, provider onboarding and a production audit remain
future work. A failed withdrawal callback leaves an unresolved pending record;
the prototype does not release it on a timeout or implement a reconciliation
service. Callbacks are deliberately small, private and bounded, but callback
recovery is required before a production launch.

The npm SDK pins nearcore 2.6.2 for local tests. A deployment must also be tested
against the current target network/runtime. No mainnet-readiness claim is made.

## Originality and next validation

Data lineage, refunds, escrow, and agent marketplaces are existing concepts.
The proposed product contribution is **economic recall handling across paid
agent dependencies**, with advance funding and exact purchase beneficiaries.
See `docs/VALIDATION.md` for primary-source comparisons and an interview plan.
The prototype establishes the mechanism, not customer demand or global novelty.

## Hackathon disclosure

Built for NEAR HACKATHON 2026 as an independent project from
[TaskVault](https://github.com/angus14/taskvault), another entry by the same
builder. TaskVault controls an agent team's purchasing budget and handoffs;
RecallPay handles paid-data corrections, dependent job pauses and funded
refunds. They have separate contracts, codebases, demos and user problems.
Suggested tracks: Agent Economy and AI Security & Defense.

## Source map

| Path | Purpose |
| --- | --- |
| `contract/src/lib.rs` | Reserve, sales, recalls, claims, payment gate and withdrawal callbacks |
| `sdk/index.mjs` | Byte verification, dependency traversal and buyer actions |
| `tests/contract.test.mjs` | Real NEAR Sandbox integration checks |
| `scripts/demo.mjs` | Full executed customer story and automatic evidence saving |
| `scripts/report.mjs` | Visual and Markdown evidence reports |
| `scripts/local.mjs` | Local RPC proxy bypass and resource-limit compatibility |
| `artifacts/build.json` | Compiler, source and artifact digests |
| `run.sh` | Single-command judge reproduction |
| `scripts/render-video.py` | Rebuild the captioned video from the JSON trace |

## License

MIT. Dependency licenses remain with their authors.
