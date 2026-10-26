# Migration subsidy

[MigrationExecutor.sol](./MigrationExecutor.sol) moves funds from an old portal (`SOURCE_PORTAL`) to a new portal (`DESTINATION_PORTAL`) of the same underlying token. [MigrationSubsidy.sol](./MigrationSubsidy.sol) pays the relayer of a migration for the gas of the whole relayer transaction. The subsidy pays only when the old portal is frozen.

## Migration executor

A withdrawal or a refund of the old portal can name the migration executor. The proof commits to the executor address and to the hash of the user payload, so a migration executor that the new version deploys can receive a withdrawal or a refund of the old version.

In each of the four flows, the old portal sends the amount to the executor and calls `execute`. The executor then:

1. Makes sure that the old portal is the caller.
2. Decodes the user payload, 64 bytes: `(bytes32 recipientCommitment, uint256 relayerTip)`. Decodes the relayer payload, 20 bytes: the tip recipient.
3. Makes sure that the tip is zero if the asset is not the payout token (`PAYOUT_TOKEN`). See [Tips](#tips).
4. Pays the tip to the tip recipient.
5. Deposits the remaining amount into the new portal under `recipientCommitment`.
6. Tells the subsidy about the migration (`recordMigration`).

The executor charges no fee. It holds no tokens between calls. It gives the new portal a maximum allowance in its constructor. OpenZeppelin ERC20 does not decrease a maximum allowance, so a DAI deposit writes no allowance slot. A token that always decreases the allowance (for example USDC) writes the allowance slot on each deposit. This costs approximately 3,000 to 5,000 gas more, and the calibration does not include it.

If the deposit into the new portal reverts, the flow of the old portal reverts too. For example, the deposit reverts when the new portal is frozen, or when `recipientCommitment` is not a field element (the Inbox rejects it).

- A refund stays pending. The user can prove the refund again, with the same executor or with another executor or payload.
- A withdrawal cannot change its executor or its user payload, because the L2 message commits to them. If the deposit always reverts, the withdrawal cannot complete. Thus the wallet can use the migration executor for refunds, but it does not use it for withdrawals.

### Tips

The user sets the tip in the user payload. The relayer cannot change it. The `OperationExecutor` pays out only the payout token. If the asset is not the payout token (for example, sUSDS with a DAI payout), a tip would stay in the `OperationExecutor`, and the next caller of the `OperationExecutor` could take it. Thus `execute` reverts with `MigrationExecutor__TipNotInPayoutToken` when the tip is not zero and the asset is not `PAYOUT_TOKEN`. The refund then stays pending, and the user can prove it again with a zero tip.

When the asset is the payout token (for example, DAI with a DAI payout), a tip is permitted. The tip is the fallback payment of the relayer when the subsidy has no balance.

The relayer gets the subsidy whatever the tip recipient is. Thus a migration with a zero tip can have a zero tip recipient. A tip that is not zero needs a tip recipient that is not zero.

## Forwarding

A relayer sends a migration through the `OperationExecutor`, which calls the subsidy. The subsidy has no function for each portal operation. Its `fallback` forwards the calldata without a change to the old portal. This is necessary because the old portal and the new portal do not have the same `refundUnprocessedDeposit` arguments, thus the function selectors are different. A function that uses the argument types of the new portal cannot call the old portal.

The subsidy never gives an allowance to the old portal. Thus a forwarded `deposit` cannot take tokens from the subsidy. The fallback rejects ether.

## Metering

The subsidy meters the whole relayer transaction, as the deposit subsidy does. It adds `TX_INTRINSIC_GAS`, the calldata gas of the forwarded call, the gas that the `OperationExecutor` used before it called the subsidy (`headGas`) and `EXIT_PATH_GAS` to the gas of its own call. `EXIT_PATH_GAS` is the gas that no meter reads: the call into the subsidy, the pricing and the payment after the measurement, and the payout of the `OperationExecutor` to the relayer.

### Refunds

The subsidy subtracts these EIP-3529 refunds:

- The payout-token balance of the `OperationExecutor` and the asset balance of the migration executor. Each slot goes back to its value at the start of the transaction. The refund is `RESTORED_ZERO_SLOT_REFUND` if the slot was zero at the start, and `RESTORED_SLOT_REFUND` if not.
- The rate-limit slot of the new portal (`Caps.$cachedAvailable`). A migration that uses all of the remaining rate limit of the new portal clears this slot and gets `CLEARED_SLOT_REFUND` (4,800 gas). The subsidy reads the slot before and after the forwarded call. If the slot goes from not zero to zero, the subsidy subtracts `CLEARED_SLOT_REFUND`.

The total refund is at most one fifth of the gross gas.

When the migration did not add payout tokens to the `OperationExecutor` (no tip, or a tip in an asset that is not the payout token), the payment of the subsidy is the first write to the balance of the `OperationExecutor`. This write costs the same gas as the refund of that slot, so the subsidy adds that refund to the gross gas.

The subsidy does not subtract a refund of 4,800 gas in two cases: the payment that empties the balance of the subsidy, and the migration that empties the balance of the old portal. Each case occurs one time only. The over-payment is less than 4,800 gas for each case.

A relayer that holds no payout token gets `FRESH_BALANCE_GAS` more, and the ceiling grows by the same value.

### Payment

The payment is `pricedGas * gasPrice * tokenPerEth + targetRelayerProfit`. The gas price is `min(tx.gasprice, block.basefee + MAX_PRIORITY_FEE_WEI)`. The payment is at most `maxSubsidyPerOperation` and at most the balance of the subsidy. If the price feed is stale or not valid, the subsidy pays nothing.

The payout token (`TOKEN`) is not always the migrated asset. For example, DAI can fund the subsidy of an sUSDS migration.

## Eligibility

The subsidy pays a migration only when all of these conditions are true:

- The caller of the subsidy runs the `OperationExecutor` code that the subsidy pins. See [OperationExecutor code](#operationexecutor-code). Other callers cause a revert.
- A code-free EOA called the `OperationExecutor` directly (`direct`), and the payout token of the `OperationExecutor` is `TOKEN`. Thus no contract can bundle other work into the transaction. Other work could increase the EIP-3529 refund cap of the transaction, and the subsidy would then subtract less refund than the EVM gives back.
- The old portal is frozen. The subsidy reads `$frozen()` of the old portal one time, before it forwards the call. The v5 portal and the v6 portal both have this getter.
- The migration executor (`EXECUTOR`) called `recordMigration` during the forwarded call. The subsidy keeps a record only while it forwards a relayer transaction that meets the conditions above, so the record applies only to the current relay. The flow and the migrated amount come from this record, not from the calldata. The tip recipient does not change the eligibility. An exit through another executor gets no payment.
- The migrated amount (the amount after the tip) is at least `minMigratedAmount`.

When the old portal is not frozen, the subsidy still forwards the call and the migration lands, but the subsidy pays nothing.

### OperationExecutor code

`OPERATION_EXECUTOR_CODEHASH` is the code hash of the `OperationExecutor` that the subsidy pays. It is immutable, and the subsidy accepts no other code hash. To stop the payments, the owner removes the balance with `defund`.

A change of the `OperationExecutor` code needs a new deployment of the migration feature with the new code hash. A user whose proof names the old migration executor makes a new proof that names the new migration executor. Nothing is spent, because a refund stays pending until a refund succeeds.

### Recovery

`defund(token)` sends the whole balance of `token` in the subsidy to the owner. Only the owner can call it. It works for any token, so the owner can also take back tokens that somebody sent to the subsidy by mistake.

## Farming bound

These values are the recommended production values:

- `targetRelayerProfit`: 0.1 DAI (`1e17`). Do not use zero. The relayer submits an operation only when the payout covers its simulated gas plus approximately 770 gas for the calldata of its gas arguments. The subsidy prices up to 2,000 gas less than the receipt gas (see [Constants and calibration](#constants-and-calibration)). Thus with a zero profit, the payout is always less than the cost that the relayer expects, and the relayer never submits the migration. The profit must cover this gap at the gas price of the relay.
- `minMigratedAmount`: approximately 1 token, in the units of the asset (for example, `1e18` for DAI).
- `maxSubsidyPerOperation`: the gas cost of the most expensive ceiling at a high gas price, plus `targetRelayerProfit`.

This table gives the highest gas price that a profit covers, for a gap of 2,000 gas. The formula is `profit / (2,000 gas * ETH price)`. Above this gas price, the relayer does not submit the migration.

| Profit   | ETH at 2,000 USD | ETH at 3,000 USD | ETH at 5,000 USD |
| -------- | ---------------- | ---------------- | ---------------- |
| 0.1 DAI  | 25 gwei          | 16.7 gwei        | 10 gwei          |
| 0.05 DAI | 12.5 gwei        | 8.3 gwei         | 5 gwei           |
| 0.01 DAI | 2.5 gwei         | 1.7 gwei         | 1 gwei           |

The bound on the gain of a farmer is:

- For each paid migration, the gain is `targetRelayerProfit` plus the pricing slack: the priced gas less the gas that the transaction really uses. The calibration tests make sure that the priced gas is at most the gas of the transaction. The remaining slack is the two once-only refunds in [Refunds](#refunds), and the capped priority fee (`MAX_PRIORITY_FEE_WEI`) for a relayer that also builds the block.
- The number of paid migrations is at most the value of the old portal at the freeze divided by `minMigratedAmount`. The subsidy pays only after the freeze, and the old portal accepts no deposits after the freeze. Each paid migration spends a position of the old portal (frozen notes, a frozen deposit, an unprocessed deposit or a withdrawal) of at least `minMigratedAmount`.

A farmer can make many positions before the freeze at a low cost. A position is not always an L1 deposit: an L2 self-transfer can split a balance into many notes, and each note can then be refunded alone. Thus the profit is the farming lever. With a profit of 0.1 DAI and a floor of 1 DAI, the farmer gets at most 0.1 DAI for each 1 DAI of positions: at most 10% of the value that it splits. For example, 1,000 DAI in 1,000 positions of 1 DAI gets at most 100 DAI of profit. Each paid migration also uses the gas of one relay, which the subsidy pays. If a farmer splits much value, the owner can decrease `targetRelayerProfit` with `setConfig`, or remove the balance with `defund`.

`minMigratedAmount` applies to the total of one refund (the migrated amount), not to each note. The wallet puts up to `MAX_FROZEN_NOTES_PER_REFUND` (ten) notes in one frozen-notes proof. Thus a user with many small notes stays eligible when the sum of the notes in one refund is at least `minMigratedAmount`.

`maxSubsidyPerOperation` and the balance of the subsidy limit the total payment.

## Constants and calibration

[MigrationSubsidy.relayedExit.t.sol](../../../test/periphery/migration/MigrationSubsidy.relayedExit.t.sol) sends each flow through a real `OperationExecutor`, subsidy and new portal (with a real Inbox) from a code-free EOA. It checks that the priced gas is at most the gas of the transaction, and at most 2,000 gas below it. These checks calibrate `EXIT_PATH_GAS`. [MigrationRelay.sol](../../../test/periphery/migration/MigrationRelay.sol) holds the shared setup.

The test file sends the flows through two old portals:

- The v6 portal of this branch, with mock refund verifiers and a real Outbox. The checks run with and without a tip, without a tip recipient, for a relayer with and without the payout token, for an `OperationExecutor` and a migration executor that hold tokens before the transaction, for a payout token that is not the asset, and for a migration that clears the rate limit of the new portal.
- The v5 portal, which is the old portal in production. [v5/](../../../test/periphery/migration/v5/) holds a copy of the v5 `OxidePortal` and the libraries that it uses, from commit `456443d0911ad517cd32d4fc10e8ee5837a14052`. The copy adds the prefix `V5` to each name and removes the comments. It uses the Inbox interface of Aztec v5.2.0 and a copy of the Aztec v5.2.0 Inbox without its fee juice portal, because the v6 Aztec Inbox has no `getRoot`. The v5 unprocessed-deposit refund carries a sibling path of 10 levels, and the v5 portal verifies it against the root of a partly filled Inbox tree. This is the most expensive `getRoot`. The v5 withdrawal uses the v6 Aztec Outbox.

The same test file checks each ceiling (`WITHDRAWAL_GAS_CEILING`, `FROZEN_NOTES_REFUND_GAS_CEILING`, `FROZEN_DEPOSITS_REFUND_GAS_CEILING`, `UNPROCESSED_DEPOSIT_REFUND_GAS_CEILING`). Keep each ceiling at least 10% above the chain cost of the most expensive honest migration of its flow on the two portals: a withdrawal with an Outbox path of 20 levels, a frozen-notes refund of the most notes, and each deposit refund. For the refunds on the v5 portal, the test also checks that the ceiling is at most 25% above the chain cost. Each relay opens a new Inbox bucket of the new portal. The chain cost adds the gas of the real refund verifier and `HARNESS_TO_CHAIN_MIGRATION_RELAY`. The v5 and v6 refund verifiers have the same `LOG_N` and the same number of public inputs, so the test uses the gas of the v6 verifiers for the two portals. `HARNESS_TO_CHAIN_MIGRATION_RELAY` is the gas that a real chain adds to the gas that the harness measures. The direct scenarios of the inter-rollup migration e2e (`yarn-project/end-to-end/src/inter_rollup.migration.ts`) give the chain side of it: they compare the L1 receipt gas of each relayed refund with the gas that the subsidy priced, and log both on a `migration-gas-offset` line. The harness side is the `tx gas` and `verification gas` lines that `MigrationSubsidy.relayedExit.t.sol` logs with `-vv` for the same refund with a new Inbox bucket. The constant is the largest difference between the receipt gas and that harness gas plus the verification gas, for a 1-note frozen-notes refund and a frozen-deposit refund, rounded up to 100 gas. No e2e test measures the offset of a withdrawal.

| Flow                                             | v6 chain cost | v5 chain cost | Ceiling   |
| ------------------------------------------------ | ------------- | ------------- | --------- |
| Withdrawal, Outbox path of 20 levels, with a tip | 367,259       | 378,519       | 427,000   |
| Frozen notes refund, 10 notes                    | 2,809,819     | 2,815,730     | 3,110,000 |
| Frozen deposit refund                            | 2,487,326     | 2,491,344     | 2,760,000 |
| Unprocessed deposit refund                       | 2,493,532     | 2,557,157     | 2,830,000 |

The wallet can use the migration executor for refunds, but it does not use it for withdrawals. Withdrawals still forward and can get a payment, but the calibration of the withdrawal ceiling is less important.

[MigrationSubsidy.farmSafety.t.sol](../../../test/periphery/migration/MigrationSubsidy.farmSafety.t.sol) checks the eligibility rules, a relay from a v5 portal that is not frozen, and the ceiling for appended calldata.

Calibrate again when the gas of a portal operation, of the `OperationExecutor` or of the subsidy changes.

## Wallet integration

A named account first updates its name record, and then migrates its funds. The record update goes first. Before the name notification of the destination, the ClaimFPC gives the account only one sponsored transaction. The record update uses it, and its notification opens the registered rail that pays for the refund broadcasts. An account that has no funds does only the record update.

### Record update

The account writes its own record with one ERC-4337 user operation that its passkey signs. The operation has zero fees and no paymaster, so it costs the account nothing and pays the relayer nothing.

1. Build the update. Call `buildRecordUpdate(publicClient, { owner, metadataRegistry, namePortal, namePortalRecipient, rollupVersion, record, passkey })` from `@oxide/oxide-client/record_update.js`. `namePortalRecipient` is the ClaimFPC of the destination. `passkey` is the public key of the passkey that signs. For a registry of another schema, also give `write`. The builder checks the registry, the rollup version, the recipients and the passkey. It returns `userOpHash`.
2. Sign `userOpHash` with the passkey. The result is a WebAuthn assertion.
3. Build the operation. Call `buildRecordUpdateOperation(publicClient, update, assertion, { target, payoutToken })`. `target` is `CANONICAL_ENTRY_POINT_V08` until a record subsidy exists. `payoutToken` is DAI. The function simulates the operation and throws when it would fail.
4. Broadcast the operation with the sponsored transaction, with the immediate condition.
5. Poll for the result. Call `readRecordUpdateResult(publicClient, update, { fromBlock })` until it returns `succeeded` with `recordHeld`. Stop on `failed`.

Rules:

- No check on chain makes sure that the record did not change after the build. A pending update can overwrite a newer record. Thus send one record update for each account at a time, and serialize every user operation of the account on nonce key 0, passkey rotations included.
- `failed` means that the account call failed. The nonce is used anyway. The L2 sponsorship is spent when the broadcast lands, even if the L1 operation never runs. To recover, a named operator pays for `NamePortal.notify` for the account on L1, which gives the account its sponsorship back. Then:
  - After `not-run` with `nonceUsed` false, broadcast the same operation again.
  - After `failed`, or `not-run` with `nonceUsed` true, build and sign the update again, which uses the new nonce.
- The relayer gets no payout for a record update. Only a relayer that runs with `--allow-unprofitable` submits it.

### Funds

A wallet migrates funds from an old portal to the new portal through `MigrationExecutor`. Every refund goes through it, the first refund too. The relayer gets its payment from `MigrationSubsidy`. This sequence is the example of a subsidy that pays in DAI for an sUSDS migration. The executor accepts a tip only when the migrated asset is the payout token of the subsidy, so for sUSDS the wallet gives no tip. For a DAI migration with a subsidy that pays in DAI, the wallet can also give a tip in step 3, with the `OperationExecutor` of the channel as the tip recipient.

1. Find the feature. Call `findMigrationFeature(entry.features, oldPortal)` from `@oxide/l1-contracts/migration.js` with the deployment entry of the new portal. It returns the `executor`, the `subsidy`, the `payoutToken` and the `destinationBridge`. When it returns `undefined`, the deployment cannot migrate funds from this portal.
2. Check the status. Call `readMigrationSubsidyTerms(publicClient, feature.subsidy)` one time, because the terms never change, then `readMigrationSubsidyState(publicClient, terms)` before each check, which is one `multicall`, and `canMigrate(migrationSubsidyStatus(terms, state), { flow, migratedAmount, gasPriceWei, baseFeeWei, nowSeconds })`. `readMigrationSubsidyStatus` does both reads in one call. When `ok` is false, show the `reasons`. The subsidy pays only when the old portal is frozen, the migrated amount is at least `minMigratedAmount`, and the price feed is fresh. `estimateMigrationSubsidy` gives an upper bound of the payout, because the subsidy meters the real transaction.
3. Build the executor call. Call `buildMigrationExecutorCall({ executor: feature.executor, recipientCommitment })` from `@oxide/oxide-lib/migration_executor.js`. Give no tip and no tip recipient: the asset is sUSDS and the subsidy pays DAI, so the executor rejects a tip. When the asset is the payout token, for example DAI with a DAI subsidy, the wallet can add `relayerTip` and `tipRecipient`; the executor then pays the tip to the recipient and deposits the remainder.
4. Build the refund. Give the executor call to the refund builder of the v5 bundle (`buildRefundFrozenNotesCalldata`, `buildRefundFrozenDepositCalldata` or `buildRefundUnprocessedDepositCalldata`). It returns the calldata for the old portal.
5. Build the operation. Call `buildMigrationOperation({ subsidy: feature.subsidy, payoutToken: feature.payoutToken, calldata })` from `@oxide/oxide-client/migration_operation.js`. The operation targets the subsidy, not the old portal. A call straight to the old portal also migrates, but the relayer then gets no subsidy.
6. Broadcast the operation on the registered rail of the ClaimFPC, with the immediate condition.
7. Poll for completion. Call `findMigrationExecution(publicClient, feature.executor, recipientCommitment, fromBlock)` until it returns the transaction. It gives the flow, the migrated amount and the tip.

Note: Use the migration executor for refunds only: frozen notes, a frozen deposit or an unprocessed deposit. Never name it in a withdrawal. A withdrawal commits to its executor and its payload at its initiation on L2, and nothing can change them after that. The migration executor only deposits into the new portal, and it reverts the withdrawal when that deposit fails. Thus a withdrawal that names it can complete only when the new portal accepts the deposit at that moment: a used rate limit delays it, a smaller per-transaction cap or a pause blocks it until the owner changes the new portal, and a freeze of the new portal blocks it for ever, because the notes are already spent on L2 and no refund can recover them. A refund has no such risk: when the deposit fails, the refund reverts, the nullifier stays unspent, and the user proves the refund again with another executor or payload. For a withdrawal, name an escrow or a SIPA as the recipient. The transfer to it cannot fail, and the deposit into the new portal is a separate step that the user can repeat or redirect.
