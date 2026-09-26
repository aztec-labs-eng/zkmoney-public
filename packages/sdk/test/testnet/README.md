# Testnet SDK E2E Suite

Manual / pre-merge gate for flows the sandbox cannot exercise: sandbox blocks mine under a second,
while testnet's 30-60s window is the minimum environment for anything that depends on real
time-to-mine.

**Not a CI job.** Testnet is non-deterministic, costs gas, and slow. Operator-run before merge.

## What's gated

| File | Validates | Default |
|---|---|---|
| `pending-record-resume.testnet.test.ts` | (Scaffold — `it.todo`.) Process-death recovery: NO_WAIT submit → wallet discarded → fresh wallet + TxLifecycleService over same `IPendingTxStore` → `resumeAll()` reconciles. Lives here but will likely move to front-core (TxLifecycleService is front-core, SDK can't import upward). | n/a — scaffold |

## Funding model — Obsidion `sponsorFPC`, NOT Aztec `SponsoredFPC`

The test account does NOT need a pre-funded fee-juice balance. All txs
go through the Obsidion-deployed `sponsorFPC`, the same fee path the
wallet uses on testnet. Seeded from the committed staging profile
document's live version — so nothing has to be running.

The oxide manifest pointer is required env: the token overlay and the
TEE signer resolve through it.

```bash
export OXIDE_MANIFEST_URL=https://<oxide-env-registry>/staging.v4.json
export OXIDE_PORTAL=0x<pinned-portal>
```

Without the pair, `setupTestnet()` errors out at `beforeAll`.

> **Do NOT use upstream Aztec's `SponsoredFPC`** (sponsored.aztec at
> `0x02a4...`). It is a different FPC with 0 fee juice on testnet, and
> the harness's `completeFeeOptions` monkey-patch deliberately routes
> around it. Verify with `FeeJuiceContract.balance_of_public(addr)` if
> you need to confirm.

## Account keys — fresh per run, no operator setup

`setupTestnet()` generates a fresh K256 signing key + Aztec secret key
via `Fr.random()` on every invocation. The account needs no deployment;
its first tx is an ordinary `entrypoint` paid through the sponsor FPC.
**No env vars, no pre-funded keys, no manual onboarding.**

## Running

Pre-req: `OXIDE_MANIFEST_URL` + `OXIDE_PORTAL` exported (see above).

```bash
# CI / no-network skip
TESTNET_SKIP=1 pnpm --prefix packages/sdk test
```

The default node URL is pinned in `packages/core/src/constants/index.ts`
as `TESTNET_NODE_URL`. Override via `TESTNET_NODE_URL_OVERRIDE` for
forks / staging. `TESTNET_PROFILE_PATH` overrides the profile document
(default `packages/backend/config-service/profiles/staging-v5.json`).

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `TESTNET_SKIP` | unset | `1` skips every testnet suite. Set in CI. |
| `OXIDE_MANIFEST_URL` / `OXIDE_PORTAL` | **required** | The oxide manifest pointer (token overlay + TEE signer). |
| `OXIDE_EXPECTED_GIT_SHA` | unset | Same-sha drift pin for the manifest. |
| `TESTNET_NODE_URL_OVERRIDE` | unset | Override the canonical testnet node URL (forks, staging). |
| `TESTNET_PROFILE_PATH` | the committed staging document | Override the profile document path. |
| `TESTNET_L1_RPC_URL` | unset | L1 JSON-RPC for the TEE binding (`attachTeeSigner`). |

## Variance

Testnet variance is intentional, not a flaw. Per-run JSON output lives under `test-results/testnet/`
(gitignored).
