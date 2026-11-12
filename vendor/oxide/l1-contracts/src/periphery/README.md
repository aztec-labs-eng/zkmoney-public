# Periphery contracts

## Deposit subsidy

[DepositSubsidy.sol](./DepositSubsidy.sol) implements the [deposit subsidy](../../../engineering-design-docs/subsidy.md#deposit-subsidy). This section tells where its gas figures come from and how the tests measure them.

### Measurement

Forge gives no transaction receipt. Thus [RelayerTransaction.sol](../../test/periphery/RelayerTransaction.sol) calculates `gasUsed` of a relayer transaction from `vm.lastCallGas`, with the base gas, the calldata gas and the refund, as the EVM does.

[DepositSubsidy.gasRows.fork.t.sol](../../test/subsidy-check/fork/DepositSubsidy.gasRows.fork.t.sol) calibrates `EXECUTOR_PATH_GAS` and the refund constants. It relays each mainnet deposit flow through the real executor, subsidy, SIPA and portal, checks that `subsidyGas` is at most `gasUsed`, and pins the gas that the subsidy does not price to within 500 gas. That gas is part of `profitCoveredGas` in [When liveness holds](../../../engineering-design-docs/subsidy.md#when-liveness-holds). [DepositSubsidy.executorPath.t.sol](../../test/subsidy-check/subsidies/DepositSubsidy.executorPath.t.sol) relays a sweep with 1 KiB of zero proofs, and checks that `subsidyGas` is at most `gasUsed`, and at most 2,000 gas (`UNDERPAY_TOLERANCE`) below it.

Forge can make the storage of an account cold again, but not the account. Thus each check sends its transaction before any other step of the test touches the accounts of that transaction.

The unit tests read a mock price feed, which uses less gas than the Chainlink feed. [DepositSubsidy.gasRows.fork.t.sol](../../test/subsidy-check/fork/DepositSubsidy.gasRows.fork.t.sol) relays each mainnet deposit flow with the mainnet tokens and the Chainlink ETH/USD feed, and pins its gas row in the [subsidy check](../../subsidy-check/README.md#gas-rows). It also checks that `subsidyGas` is at most `gasUsed`, for a relayer that holds the payout token and for one that does not. The USDC and USDT sweeps swap to DAI through the Curve 3pool, also from a SIPA that already holds DAI.

The `e2e_deposit_subsidy/sweeps` suite checks the gas rows of three flows against the receipts of their relayer transactions.

### Gas refunds

No contract can read the EIP-3529 refund of its transaction. Thus the subsidy subtracts a constant for each slot that a sweep clears or restores. The tests in [Measurement](#measurement) compare these constants with the refund that forge counts.

The subsidy does not subtract the refund of 4,800 gas of the payment that empties its balance. This occurs once for each top-up. In this case, `subsidyGas` can be more than `gasUsed`, which [Why farming is prevented](../../../engineering-design-docs/subsidy.md#why-farming-is-prevented) does not allow.

## Subsidy gas ceilings

Each intent has a ceiling in [DepositSubsidy.sol](./DepositSubsidy.sol) that limits `subsidyGas`. Below its ceiling, the meter prices an operation. When an operation goes over the ceiling constant, the relayer pays for the gas over it. An intent without a ceiling gets no subsidy. The constructor takes the starting ceilings, and the owner can change them with `setSweepGasCeiling`.

For each mainnet deposit flow, [DepositSubsidy.gasRows.fork.t.sol](../../test/subsidy-check/fork/DepositSubsidy.gasRows.fork.t.sol) measures the gas that the subsidy does not price, with the gas over a ceiling constant, and pins it in the flow's gas row. The [subsidy check](../../subsidy-check/README.md#gas-rows) then tests that the relayer's margin, the smaller of `targetRelayerProfit` and the sweep tip, pays for that gas at the flow's target gas price. When you change a deposit or registration ceiling, the deploy allowance or a swap hop, update the gas rows and run the subsidy check.

Other gas pins:
- [DepositSubsidy.sweepGas.t.sol](../../test/subsidy-check/subsidies/DepositSubsidy.sweepGas.t.sol) checks that the meter, not the ceiling, prices a resweep through the deploy entry and the cheapest registration.

Add-passkey sweeps get no subsidy: their intent's ceiling is 0.

Measure again when the gas of an operation changes.
