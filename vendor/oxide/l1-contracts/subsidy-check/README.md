# Subsidy check

This check tests, with forge only, that each relayer subsidy meets its two goals: liveness and no farming. [subsidy.md](../../engineering-design-docs/subsidy.md) defines the goals and the terms, and shows why the deposit subsidy meets them. This README tells you where the tests are, and what they show that the code does not.

Run the check from the repository root:

```sh
./l1-contracts/subsidy-check/check.sh
```

CI runs every forge test once, and `check.sh --forge-results` reads those results.

## Terms

This README uses the terms of [subsidy.md](../../engineering-design-docs/subsidy.md#terms) and of [Payout and profit](../../engineering-design-docs/relayer.md#payout-and-profit), and these terms:

- **Required payout**: the smallest payout that `OperationExecutor` accepts, `gasToCover × tx.gasprice` in the payout token, rounded up.
- **Live**: the payout is at least the required payout. The subsidy rounds down and the executor rounds up, so the tests keep a margin of 1 token-wei. Without it, the payout can be 1 token-wei short.
- **Flow**: one SIPA sweep that a relayer sends on mainnet. It is one operation (a deposit or a registration) from one token, in one state of the SIPA (for example, a first sweep or a resweep), with the fee and the config of one forwarding-table row.
- **Target**: the prices at which each flow must be live: a 5 gwei base fee, a 0.1 gwei priority fee, and ETH at $5,000.
- **Known gap**: a property that a subsidy does not meet today. It has a label of its cause, such as `DaiConfig`, and a test with `Gap_<label>_` in its name that passes while the gap is there. A fix makes this test fail, so the fix must also remove the gap test and the gap's entry.

## Pricing tests

`test/subsidy-check/subsidies/` has a quote test file for each tested subsidy. The tests call the production pricing function. `SubsidyHarnesses.sol` exposes the internal ones. The tests show:

- **No farming**: the subsidy pays at most the gas that it prices (for a migration, plus `targetRelayerProfit`), and at most its cap and its balance.
- **Liveness**: when the profit and the cap are large enough for the gas of the transaction, and the balance holds the cap, the transaction is live. For the deposit subsidy, [When liveness holds](../../engineering-design-docs/subsidy.md#when-liveness-holds) gives these limits.
- **Lower prices**: a transaction that is live stays live at every lower gas price and ETH price. See [Lower prices](#lower-prices).
- **Exact quote**: for each input up to 2^128 token-wei, the subsidy is its pricing formula. This includes a gas cost above 2^128 token-wei before the cap applies. No real flow gets near these values, but the code accepts them.
- **Token decimals**: `tokenWeiPerEth` is the feed price × 10^decimals / 10^8 for a token with 0 to 36 decimals. A quote in a 6-decimal token pays the gas in the units of that token.
- **Price feed**: the quote reads the ETH/USD feed only while its answer is not negative, not dated ahead, and at most `MAX_PRICE_AGE` old.
- **Farm safety**: only a relayer transaction draws from the pot. See [Farm safety](#farm-safety).

| Subsidy | What it pays | Tests |
| --- | --- | --- |
| `DepositSubsidy` | `subsidy`, as [subsidy.md](../../engineering-design-docs/subsidy.md#terms) defines it | `DepositSubsidy.quote.t.sol` |
| `MigrationSubsidy` | The gas that it measures, plus `targetRelayerProfit`. The subsidy alone pays the relayer. | `MigrationSubsidy.quote.t.sol` |

- The migration subsidy pays a profit on purpose, so no test requires that a relayer gains nothing, and it has no farm-safety property. `test/periphery/migration/MigrationSubsidy.farmSafety.t.sol` shows that it pays only for a relayer transaction from a frozen portal, one time for each migration, and only at or above `minMigratedAmount`.

## Deposit meter

The deposit subsidy measures the gas of its own call, and calculates the rest of the [relayer transaction](../../engineering-design-docs/subsidy.md#relayer-transaction). `DepositSubsidy.meter.t.sol` shows that `subsidyGas` is at most the gas that the transaction is charged, that the ceiling limits it, and that the meter prices calldata at the EVM cost. `DepositSubsidy.payment.t.sol` tests the payment through the real `OperationExecutor`. The other deposit suites test the owner's controls, and relays in states that no gas row measures.

## Farm safety

`SubsidyFarmSafety.sol` sends each caller shape through the real contracts. Only a [relayer transaction](../../engineering-design-docs/subsidy.md#relayer-transaction) may draw from the pot. Every other shape must leave the pot unchanged, and a shape whose operation still runs must run it. Each shape changes one thing from the relayer transaction, so a subsidy that drops that check pays it, unless another contract makes the same check.

To give a subsidy the property, inherit `SubsidyFarmSafety` in its test contract and implement the hooks (see `DepositSubsidy.farmSafety.t.sol`). A shape that only this subsidy has is a hook value. Then name the two tests of the property in the subsidy's entry.

## Write a property test

- Make each input inside the premise of the property with `bound()`. Do not call `vm.assume`, and do not return early. Then each fuzz run tests the property. `registry.py` fails a fuzz test that does either. It also fails a fuzz test that calls `vm.assume` through a helper or a modifier in its file or in a test file that it imports, or through an assume helper of forge-std.
- For each property, add a test with fixed inputs at which the subsidy pays more than 0. A subsidy that pays nothing never overpays, so without this test a broken subsidy can pass the no-farming test.
- Add fixed tests at the boundaries, for example where the cap or the balance limits the payment, or where the priority fee is at `MAX_PRIORITY_FEE_WEI`. The fuzzer seldom finds an exact boundary.
- Test the exact quote for all the values that the code accepts, not only the values of real flows, and test a token that does not have 18 decimals. A cast that cuts a value, or a wrong unit, can give the correct result at the values of real flows.
- Put the test in `test/subsidy-check/`, in a file whose name contains `Subsidy` and a test contract whose name starts with the subsidy's name. Then add the test to the subsidy's entry in `registry.py`.

## Lower prices

The fuzz tests sample lower prices. This argument covers all of them. [When liveness holds](../../engineering-design-docs/subsidy.md#when-liveness-holds) shows that the deposit subsidy is live at every gas price up to a limit. Thus a transaction that is live at one gas price is live at each lower gas price. A lower ETH price has the same effect as a lower gas price, because the gas cost in tokens is `gasToCover × tx.gasprice × tokenWeiPerEth`. A transaction with less `gasToCover` and less `profitCoveredGas` costs less, so it is live too. The 1 token-wei margin covers the rounding at each price.

The same argument holds for the migration subsidy, with no fee.

## Gas rows

`gas.json` has one row for each execution variant of a deposit sweep: its token, a first sweep or a resweep, and DAI that is already in the SIPA. Each row has two upper bounds: `coverGas` on `gasToCover`, and `unpricedGas` on `profitCoveredGas`. `test/subsidy-check/fork/DepositSubsidy.gasRows.fork.t.sol` measures each row on a pinned mainnet fork, and fails when a bound is below the measurement or too far above it. `states.json` lists the variants, so a new variant with no row fails the check.

About the measurements:

- Each row is measured in the state that costs the most gas: cold accounts, a new inbox bucket, and a relayer that holds none of the payout token.
- Each fork suite runs with `forge-config: default.isolate = true`, so forge runs each call as its own transaction: it charges the base gas, the calldata gas and the cold accounts as the chain does, and the transaction gas is the gas used less the capped refund. Without isolation, an account that the test touched before the relay stays warm, because `vm.cool` makes only the storage cold. `setUp` fails when the suite does not run isolated.
- The chain cover of a row is the transaction gas plus `relayerCalldataPadding`.
- The bounds assume that the relayer's first gas limit, 3/2 of the gas used, succeeds ([Evaluation sequence](../../engineering-design-docs/relayer.md#evaluation-sequence)). The settlements check this.
- A USDC or USDT SIPA can hold DAI when its sweep runs, because anyone can send DAI to it. These variants have their own rows (`idleDai`).

`gen.py` writes the pins and their staging order from `gas.json`. After you change a row, run it:

```sh
python3 -I l1-contracts/subsidy-check/gen.py
```

The check fails when a generated file is not what `gen.py` writes. A new operation or token also needs its staging in `test/subsidy-check/fork/DepositSubsidyGasRowsFixture.sol`.

## Flows at the target

`gen.py` writes a corner test for each flow in `test/subsidy-check/subsidies/DepositSubsidy.flowCorners.t.sol`, from the seeds and `gas.json`. A corner test runs the production quote with the flow's config, at the target and at the flow's gas bounds: the highest prices and the most gas. The flow must be live there. By [Lower prices](#lower-prices), it is then live at every lower price and for every transaction inside its bounds. A flow that is not live is a known gap in `flows.GAP_FLOWS`.

Each intent that a seed routes with a gas ceiling above 0 must have rows in `gas.json`. An intent with a ceiling of 0 gets no subsidy, so the check skips it.

The subsidy prices an sUSDS share at $1, but the relayer values a share at its real price, which is more. Thus a flow that is live at $1 a share is live at the real price.

To add a flow, add its row to `gas.json` and the seed row that routes it, then run `gen.py`.

## Settlements on the fork

The corner tests use the bounds in `gas.json`. `test/subsidy-check/fork/DepositSubsidy.settlements.fork.t.sol`, which `gen.py` also writes, relays each flow on the mainnet fork at the production config, the way the relayer does. `test/subsidy-check/fork/RelayerCoverRule.sol` is a port of the relayer's [evaluation sequence](../../engineering-design-docs/relayer.md#evaluation-sequence). These tests use real gas, so their results can be different from the corner tests. Each flow has two tests:

- **Settlement**: the relayer sends the flow at its first gas limit, as the gas rows assume, and the flow is live at the fork's ETH price and at the target. A flow that fails is a known gap in `flows.SETTLEMENT_GAP_FLOWS`.
- **Farming**: a relayer that holds the payout token relays the flow. Its gain is the subsidy at the token's real value, less the gas cost. The fee nets out, because the farmer is both the depositor and the relayer. The gain must be 0 or less. A flow that gains is a known gap in `flows.FARMING_GAP_FLOWS`.

`test/subsidy-check/fork/DepositSubsidy.settlementStates.fork.t.sol` tests what the relayer does in the states around the payment, for example when the cap is below its cost or the subsidy's balance is empty.

## Every subsidy is tested or exempt

`registry.py` lists each subsidy with the tests that it needs and its known gaps, or with the reason that it is exempt. The check finds each subsidy in the source: a contract that reads the gas price, inherits a contract that does, or calls a library that does. A contract that only calls a subsidy contract is not a subsidy. It fails when a subsidy has no entry, when another contract or library has the name of a subsidy, or when a test that an entry names did not pass. An exemption has a reason and a hash of the contract's source: the imports of its file, its declaration, its body and each contract under `src` that it inherits. A change to any of them fails the check until a reviewer accepts the exemption again. The hash does not cover the libraries that the contract calls.

### Where the subsidy tests are

Each subsidy test is in `test/subsidy-check/`, and the registry names it. The check fails on a subsidy test elsewhere and on a test there that the registry does not name. Do not write a relay-pricing or ceiling-calibration test by hand: add a gas row.

The check reads the source, so it does not find every subsidy. A reviewer must ask for an entry for a free function that reads the gas price, a contract that gets the gas price as an argument, and a contract that prices through an external call.

## Config report

`report.py` runs the gas-row pins and the settlements, and prints a row for each flow: the gas on the fork, the cost at the target, the highest gas price at which the flow is live, and the smallest cap and profit that make it live at the target. Use it to choose the numbers in the seeds. Its formula must give the payout that each settlement logs and the result of each corner test, so the report agrees with the production quote.

```sh
python3 -I l1-contracts/subsidy-check/report.py
```

## Limits

Forge tests fixed inputs and samples, not every input. A change that is wrong only at inputs that no fixed test uses and the fuzzer does not sample can pass.
