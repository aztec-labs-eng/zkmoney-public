# Oxide Relayer

The purpose of oxide relayer is to finish actions on L1 on behalf of users without them needing to own ETH for gas.

Users pay the relayer in USD (DAI stablecoin).
The relayer prices each action against the L1 gas cost and only submits the ones that pay for themselves. Every flow is permissionless: nobody has to trust the relayer, and the relayer does not have to trust the data it reads.

The relayer is a single long-running process. It reads the deployment env manifest `<env>.v4.json` (`--deployment-env-manifest`) and pins one entry by portal (`--portal`, or the `OXIDE_PORTAL` environment variable). It runs epoch proofs and FPC funding for that deployment. In `l1-operations` mode, it also watches the other manifest portals with the same rollup version that support L1 operations. Each worker uses the contracts published for its own deployment. The relayer does not start if the manifest has an entry that it cannot parse, or if the pinned entry publishes the zero address for a subsidy contract that an enabled mode needs.

Run `oxide-relayer run --help` for the full option list.

## How to run it

The relayer needs an L1 RPC, an Aztec node, the deployment env manifest and the portal to serve, a funded L1 signer, and a writable path for its SQLite state:

```bash
oxide-relayer run \
  --deployment-env-manifest https://<oxide-deployment-env-manifest>/prod.v4.json \
  --portal 0x<portal-address> \
  --read-l1-rpc https://<ethereum-rpc> \
  --aztec-node https://<aztec-node> \
  --signer keystore \
  --keystore /data/relayer.json \
  --keystore-password-file /run/secrets/relayer-keystore-password \
  --modes l1-operations
```

Each flag has an environment variable equivalent, mostly `OXIDE_RELAYER_*`. `oxide-relayer run --help` prints the variable next to its flag. When a variable is set, help shows its value as the default, except for `--keystore-password` and `--predicate-api-key`, where help shows `<redacted>`. At startup, the relayer logs the resolved config. The log redacts secrets and shows only the origin of each RPC URL.

A secret on the command line is visible to other processes on the host, so prefer the environment or a file for secrets. The `--signer env` backend reads its key from `L1_PRIVATE_KEY`. For a keystore, use `--keystore-password-file` or `OXIDE_RELAYER_KEYSTORE_PASSWORD`. Set the Aztec node API key with `AZTEC_NODE_API_KEY` (fallback `OXIDE_AZTEC_NODE_API_KEY`); this setting has no command-line flag.

Use `--state` or `OXIDE_RELAYER_STATE_PATH` to select the SQLite path. Keep `{portal}` in the path for multiple deployments and mount its directory in Docker. SQLite is the only state backend.

These options have been removed: `--worker-id`, `--lease-ttl-ms`, `--sqlite-path`, `--predicate-base-url`, and `--predicate-timeout-ms`. The relayer ignores their environment variables. If you used `--sqlite-path` or `OXIDE_RELAYER_SQLITE_PATH`, move the same path to `--state` or `OXIDE_RELAYER_STATE_PATH`, or the relayer opens a new database.

Mainnet submissions use Flashbots Protect. Sepolia submissions use the public mempool through the configured read RPC, which must accept transaction submission. Give `--read-l1-rpc` a normal RPC that supports `eth_simulateV1` for L1 operations. `--flashbots-block-range` defaults to 5: it controls the Protect drop window on mainnet and the local transaction expiry on Sepolia. Expiry on Sepolia does not cancel a transaction or release its nonce.

`--disable-submission` (`DISABLE_SUBMISSION=1`) runs all checks and simulations, but does not send L1 transactions. The relayer treats each transaction as mined, so it records metrics as a real relayer does. We use it to observe prod. If you do not configure a signer key, the relayer uses a random key. This setting does not support `epoch-proofs`. Restart the process to apply environment changes; this setting does not cancel transactions already submitted.

## Docker image

The public image is [`azteclabs/oxide-relayer`](https://hub.docker.com/r/azteclabs/oxide-relayer). Mount `/data` to keep the SQLite state and the keystore:

```bash
docker run -v /srv/oxide-relayer:/data azteclabs/oxide-relayer:X.Y.Z run \
  --deployment-env-manifest https://<oxide-deployment-env-manifest>/prod.v4.json \
  ...
```

Use an exact version (`X.Y.Z`) in production. The tags `X.Y`, `X`, and `latest` move to the newest stable release in their line. Release candidates (`X.Y.Z-rc.N`) do not move a tag. `oxide-relayer --version` prints the version of the image. A build that is not a release prints `dev`.

## Releases

The relayer has its own semantic version, separate from the protocol labels. See [Releases](../../engineering-design-docs/relayer.md#releases) for the version rules.

To release:

1. Push the tag `relayer/vX.Y.Z` (or `relayer/vX.Y.Z-rc.N`) on a commit on `main`. Push one tag at a time. Releases run one after the other, and GitHub keeps only one waiting release, so a third tag cancels the waiting one. If a release shows as cancelled, re-run it.
2. The `release` workflow builds the image, checks that it reports the version, pushes it to Docker Hub, and creates a GitHub release with the image digest.
3. Edit the GitHub release notes to list the prod manifest entries that this release serves.

## User flows

The relayer runs one or more modes, selected with `--modes`. Each mode is one user flow.

### 1. Early epoch proofs and prover claims (`--modes epoch-proofs`)

A withdrawal can only be finalized once the epoch that contains it is proven. Waiting for the full epoch delays every withdrawal in it.

A partial epoch proof covers the epoch from its first checkpoint to the most recent one, and not the full epoch. The withdrawals in those checkpoints are then finalized before the epoch closes.

In this mode, the relayer does not prove. It runs next to a prover node, which does the proving. The relayer watches the prover tips that accumulate in the current epoch. When the tips plus the subsidy pay for the proving and the `submitEpochProof` gas, the relayer asks the prover node to prove those checkpoints now. The user gets paid earlier, and the prover node becomes the first prover of those checkpoints.

The relayer then claims the prover tips. The Portal records the prover id of the proof as the first prover, and pays a claim only to that address. Thus the prover id must be the relayer signer address. Set these prover node settings:

- `PROVER_ID`: the relayer signer address. If you do not set it, the prover id is the address that publishes the proofs, and the relayer cannot claim the tips.
- `PROVER_NODE_PROOF_SUBMISSION_TARGET_ADDRESS`: the `firstProverProofSubmitter` of the pinned manifest entry. A proof sent directly to the rollup records no first prover.

This mode also requires `--prover-node-url`, a nonzero `proverSubsidy`, and an enclave URL in the pinned manifest entry. If the prover node's admin API requires an API key, which `aztec start` enables by default, set `OXIDE_RELAYER_PROVER_NODE_API_KEY` to it.

This mode is temporary. When the Aztec protocol enshrines early epoch proofs, we remove the mode. All of its code is in `src/prover/`.

### 2. L1 operations (`--modes l1-operations`)

A user needs an L1 call made from a rollup version that no longer has sequencers. This channel exists for withdrawals and refunds out of a frozen portal, but it carries an arbitrary L1 call: the user publishes `(target, payoutToken, l1Calldata)` on the canonical version as an L1 operation broadcast, and a relayer there can execute it without knowing anything about the old version. The relayer does not decode the call. It screens `target`, `payoutToken`, and every address the simulation's logs expose against the OFAC SDN list (and Predicate when configured); a match blocks the operation for good.

The relayer:

1. Watches the small `L1Operation` public logs of the L2 Broadcaster through the _pending_ L2 head,
2. fetches `(target, payoutToken, l1Calldata)` from the broadcasting transaction, which the node only holds until the transaction finalizes,
3. screens, simulates the call with `eth_simulateV1`, screens the addresses its logs expose, and executes it through the `OperationExecutor` with its break-even point as `minPayout`.

The `OperationExecutor` transfers the whole resulting `payoutToken` balance to the relayer and reverts when the payout is below `minPayout`. Mainnet uses Protect to avoid including reverting transactions. Sepolia uses the public mempool, where an included revert consumes gas.

The caller of `broadcast` chooses the `payoutToken` of each operation. Thus the relayer accepts only operations whose `payoutToken` is in its list of payout tokens, and does not store other operations. `--l1-operations-payout-tokens` (`OXIDE_RELAYER_L1_OPERATIONS_PAYOUT_TOKENS`) sets the list, as comma-separated addresses. When it is not set, a deployment accepts only the `token` of its manifest entry.

The read RPC must answer `eth_simulateV1`; the mode probes it at startup. The screen sees only what the simulation logs: a contract that emits nothing, a non-standard token, or a recipient that state changes before inclusion is not seen.

See [Relayer](../../engineering-design-docs/relayer.md).

### Priority fee

The relayer sets the L1 priority fee to the `eth_maxPriorityFeePerGas` estimate of the read RPC. For L1 operations, the relayer caps this value at `MAX_PRIORITY_FEE_WEI` (0.1 gwei, in `noir-projects/oxide_lib/src/constants.nr`).
This is done since subsidy pays for gas at no more than the base fee plus this capped priority fee.

### Max fee per gas

Set `--l1-max-fee-per-gas-gwei` (`OXIDE_RELAYER_L1_MAX_FEE_PER_GAS_GWEI`) to limit the gas price the relayer pays. When the `maxFeePerGas` of a quote is more than the cap, the relayer does not send the transaction. L1 operations, FPC funding, and prover claim batches stay pending and the relayer quotes them again on the next poll. The max pending age still applies, and a prover claim can expire while the fee stays above the cap.

## Economic model

The relayer pays for gas in ETH and gets paid in DAI, a USD-pegged 18-decimal token.

### L1 Operations

The gas limit is estimated using `eth_estimateGas`.
The gas limit is more than the gas the transaction pays for: it includes gas that is refunded at the end of the transaction, and gas that a call must hold but does not use (EIP-150).
In prod transactions, the gas limit is 7% to 26% more than the gas used, by operation type.
The relayer therefore simulates the transaction with `eth_simulateV1` and computes the minimum USD payout as `minPayout = weiToUSD(simulatedGasUsed * maxFeePerGas)` (Chainlink ETH/USD feed is used for this conversion).
The transaction costs more than `minPayout` only if it uses more gas at inclusion than in the simulation, and it can never cost more than `gasLimit * maxFeePerGas`.

`maxFeePerGas` is the market fee plus a headroom that keeps the transaction valid if the base fee increases before inclusion. One block can increase the base fee by at most 12.5%. The default headroom is 6.25%. Set it with `--l1-operations-max-fee-headroom-percent` (`OXIDE_RELAYER_L1_OPERATIONS_MAX_FEE_HEADROOM_PERCENT`). More headroom makes `minPayout` higher, so the relayer defers more operations as unprofitable.

`maxFeePerGas` is the market fee plus a headroom that keeps the transaction valid if the base fee increases before inclusion. One block can increase the base fee by at most 12.5%. The default headroom is 6.25%. Set it with `--l1-operations-max-fee-headroom-percent` (`OXIDE_RELAYER_L1_OPERATIONS_MAX_FEE_HEADROOM_PERCENT`). More headroom makes `minPayout` higher, so the relayer defers more operations as unprofitable.

We use the `OperationExecutor` contract, which gurantees that the tx reverts if the min payout is not obtained.
On mainnet this is then used along with Flashbots Protect, which the relayer submits through, and which drops reverting transactions to guarantee that a relayer doesn't turn a loss.

We don't have the guarantee of knowing the payout ahead of time, because the operation may have already been executed by another relayer, in which case we receive no tip from it.

### Early EpochProofs

`--early-proof-min-profit` and `--early-proof-proving-cost-per-checkpoint` use integer USD amounts scaled by 10^18. `--early-proof-min-profit-margin-bps` uses basis points of the reward value. All three default to zero. Set the proving cost to account for off-chain compute. `--allow-unprofitable` applies only to L1 operations and FPC funding; it does not bypass epoch-proof profitability checks.

In the case of early epoch proofs the spend happens before the relayer can be paid.
A partial epoch proof costs off-chain compute, and the prover claim that pays for it is a later, separate transaction.
There is no on-chain `minPayout` that can make that spend conditional, so the relayer starts a partial epoch proof only when the accumulated prover tips plus the subsidy cover the gas of the proof submission, which grows with the checkpoints the prefix covers, the modelled proving cost per checkpoint (`--early-proof-proving-cost-per-checkpoint`), `--early-proof-min-profit`, and a profit margin (`--early-proof-min-profit-margin-bps`).
The margin covers what can change after that decision: L1 gas can get more expensive before the claim transaction is sent, and another prover can advance the proven tip to those checkpoints first, in which case the relayer paid for compute it will never be recorded as first prover for.

The prover claim batch itself is priced the same way as every other batch: tips plus subsidy against `gasLimit * maxFeePerGas`, quoted with one gas price for the whole selection, with the lowest-tip claim dropped until the batch clears the floor.

## L1 operations across deployments

In `l1-operations` mode, the relayer watches the pinned portal and other entries in the same schema-4 manifest with the same `rollupVersion` and `withdrawalProtocol: "l1-operation"`. Historical entries with a missing or different protocol are ignored because older broadcasters can use incompatible condition values. The relayer reads only the pinned entry and these historical entries. If a historical entry does not have a field that the relayer uses, the relayer logs a warning and does not watch that entry. Labels are names; their spelling and order do not select deployments. A separate worker uses each deployment's broadcaster, token, portal, executor, and enclave. All workers share the node, L1 clients, L1 tx queue, price oracle, and operating policy. Epoch-proof and FPC-funding services remain attached to the pinned deployment. The relayer refreshes the manifest every 5 minutes in this mode to add compatible workers and keeps existing workers active.

Use a state path with `{portal}` when multiple workers need state, for example `/data/oxide-relayer-{portal}.sqlite3`. A single deployment can use a literal path, but adding workers requires `{portal}`. Each worker retains the existing operation cursors, screening, retries, and submission behavior. A fresh database starts discovery at the proven tip, since broadcast payloads have a limited lifetime. Preserve the databases across restarts to resume stored work. Completed operations are not submitted again.

A historical worker's startup failure does not stop the primary worker. Startup retries occur after 15 seconds, 60 seconds, and 300 seconds. After the fourth failure, the log reports that the portal is not watched until restart. Logs identify each deployment, and the existing backlog metrics count operations across all active workers. With submission disabled, workers continue discovery. Shutdown stops workers and cancels retries before it drains the shared L1 tx queue and closes the stores.
