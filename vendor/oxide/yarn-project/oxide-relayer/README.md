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

Each flag has an environment variable equivalent, mostly `OXIDE_RELAYER_*`. `oxide-relayer run --help` prints the variable next to its flag.

## User flows

The relayer runs one or more modes, selected with `--modes`. Each mode is one user flow.

### 1. Early epoch proofs and prover claims (`--modes epoch-proofs`)

A withdrawal can only be finalized once the epoch that contains it is proven. Waiting for the full epoch delays every withdrawal in it.

A partial epoch proof covers the epoch from its first checkpoint to the most recent one, and not the full epoch. The withdrawals in those checkpoints are then finalized before the epoch closes.

The relayer watches the prover tips that accumulate in the current epoch and, when they plus the subsidy cover the proving and `submitEpochProof` cost, asks the configured prover node to prove those checkpoints now. The user gets paid earlier, and the prover the relayer is connected to via `--prover-node-url` becomes the first prover of those checkpoints.

The relayer then automatically claims the prover tips.

This mode is temporary. When the Aztec protocol enshrines early epoch proofs, we remove the mode. All of its code is in `src/prover/`.

### 2. L1 operations (`--modes l1-operations`)

A user needs an L1 call made from a rollup version that no longer has sequencers. This channel exists for withdrawals and refunds out of a frozen portal, but it carries an arbitrary L1 call: the user publishes `(target, payoutToken, l1Calldata)` on the canonical version as an L1 operation broadcast, and a relayer there can execute it without knowing anything about the old version. The relayer does not decode the call. It screens `target`, `payoutToken`, and every address the simulation's logs expose against the OFAC SDN list (and Predicate when configured); a match blocks the operation for good.

The relayer:

1. Watches the small `L1Operation` public logs of the L2 Broadcaster through the _pending_ L2 head,
2. fetches `(target, payoutToken, l1Calldata)` from the broadcasting transaction, which the node only holds until the transaction finalizes,
3. screens, simulates the call with `eth_simulateV1`, screens the addresses its logs expose, and executes it through the `OperationExecutor` with its break-even point as `minPayout`.

The `OperationExecutor` transfers the whole resulting `payoutToken` balance to the relayer, and reverts when the payout is below `minPayout`, so a lost race or a garbage broadcast costs the relayer nothing but the simulation.

The read RPC must answer `eth_simulateV1`; the mode probes it at startup. The screen sees only what the simulation logs: a contract that emits nothing, a non-standard token, or a recipient that state changes before inclusion is not seen.

See [Relayer](../../engineering-design-docs/relayer.md).


### Priority fee floor

A quiet chain prices the priority fee near zero, and no builder includes a transaction that tips that little. The relayer therefore applies a floor to the tip it computes. A market tip above the floor still wins. Set the floor with `--l1-min-priority-fee-gwei` (`OXIDE_RELAYER_L1_MIN_PRIORITY_FEE_GWEI`).

The default floor is 0.1 gwei, which suits mainnet: mainnet blocks include a small tip, and a larger floor raises the payout every action must return for no gain in inclusion. Sepolia submits to its public mempool, where local builders order by tip, so a deploy to a Sepolia chain sets the floor to 1 gwei unless the environment already gives a value. A relayer you start by hand against Sepolia gets the 0.1 gwei default, so set the variable yourself.

The floor raises `maxFeePerGas` by the same amount, and every mode prices its payout floor against `maxFeePerGas`, so a larger floor also raises the payout each action must return before the relayer submits it.

## Economic model

The relayer pays for gas in ETH and gets paid in DAI, a USD-pegged 18-decimal token.

### L1 Operations

An EIP-1559 transaction can never cost more than `gasLimit * maxFeePerGas`.
The relayer therefore knows the worst-case cost of a transaction before it signs it.

The gas limit is estimated using `eth_estimateGas`.
Then based on that we can compute the minimum USD payoud as `minPayout = weiToUSD(gasLimit * maxFeePerGas)` (Chainlink ETH/USD feed is used for this conversion).

We use the `OperationExecutor` contract, which gurantees that the tx reverts if the min payout is not obtained.
On mainnet this is then used along with Flashbots Protect, which the relayer submits through, and which drops reverting transactions to guarantee that a relayer doesn't turn a loss.

We don't have the guarantee of knowing the payout ahead of time, because the operation may have already been executed by another relayer, in which case we receive no tip from it.

### Early EpochProofs

In the case of early epoch proofs the spend happens before the relayer can be paid.
A partial epoch proof costs off-chain compute, and the prover claim that pays for it is a later, separate transaction.
There is no on-chain `minPayout` that can make that spend conditional, so the relayer starts a partial epoch proof only when the accumulated prover tips plus the subsidy cover the gas of the claim transaction, the modelled proving cost per checkpoint (`--early-proof-proving-cost-per-checkpoint`), `--early-proof-min-profit`, and a profit margin (`--early-proof-min-profit-margin-bps`).
The margin covers what can change after that decision: L1 gas can get more expensive before the claim transaction is sent, and another prover can advance the proven tip to those checkpoints first, in which case the relayer paid for compute it will never be recorded as first prover for.

The prover claim batch itself is priced the same way as every other batch: tips plus subsidy against `gasLimit * maxFeePerGas`, quoted with one gas price for the whole selection, with the lowest-tip claim dropped until the batch clears the floor.

## L1 operations across deployments

In `l1-operations` mode, the relayer watches the pinned portal and other entries in the same schema-4 manifest with the same `rollupVersion` and `withdrawalProtocol: "l1-operation"`. Historical entries with a missing or different protocol are skipped because older broadcasters can use incompatible condition values. Labels are names; their spelling and order do not select deployments. A separate worker uses each deployment's broadcaster, token, portal, executor, and enclave. All workers share the node, L1 clients, transaction batcher, price oracle, and operating policy. Epoch-proof and FPC-funding services remain attached to the pinned deployment. The relayer reads the manifest only at startup; restart it to apply changes to the deployment list.

Use a state path with `{portal}` when multiple workers need state, for example `/data/oxide-relayer-{portal}.sqlite3`. A single deployment can use a literal path. Each worker retains the existing operation cursors, screening, retries, and submission behavior. A fresh database starts discovery at the proven tip, since broadcast payloads have a limited lifetime. Preserve the databases across restarts to resume stored work. Completed operations are not submitted again.

A historical worker's startup failure does not stop the primary worker. Startup retries occur after 15 seconds, 60 seconds, and 300 seconds. After the fourth failure, the log reports that the portal is not watched until restart. Logs identify each deployment, and the existing backlog metrics count operations across all active workers. With submission disabled, workers continue discovery. Shutdown stops workers and cancels retries before it drains the shared batcher and closes the stores.
