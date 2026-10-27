# Periphery contracts

## Deposit subsidy

[DepositSubsidy.sol](./DepositSubsidy.sol) implements the [deposit subsidy](../../../engineering-design-docs/subsidy.md#deposit-subsidy). This section tells where its gas figures come from and how the tests measure them.

### Measurement

Forge gives no transaction receipt. Thus [RelayerTransaction.sol](../../test/periphery/RelayerTransaction.sol) calculates `gasUsed` of a relayer transaction from `vm.lastCallGas`, with the base gas, the calldata gas and the refund, as the EVM does.

[DepositSubsidy.executorPath.t.sol](../../test/periphery/DepositSubsidy.executorPath.t.sol) sends each kind of relayer transaction through the real executor, subsidy, SIPA and portal. It checks that `subsidyGas` is at most `gasUsed`, and at most 2,000 gas (`UNDERPAY_TOLERANCE`) below it. This calibrates `EXECUTOR_PATH_GAS` and checks the refund constants. The difference is part of `profitCoveredGas` in [When liveness holds](../../../engineering-design-docs/subsidy.md#when-liveness-holds).

Forge can make the storage of an account cold again, but not the account. Thus each check sends its transaction before any other step of the test touches the accounts of that transaction.

The unit tests read a mock price feed, which uses less gas than the Chainlink feed. [DepositSubsidy.executorPath.fork.t.sol](../../test/fork/DepositSubsidy.executorPath.fork.t.sol) makes the same checks with mainnet DAI and the Chainlink ETH/USD feed. It also relays USDC and USDT sweeps, which swap to DAI through the Curve 3pool.

The `e2e_deposit_subsidy` ladder checks each payment against the gas in the receipt of its relayer transaction.

### Gas refunds

No contract can read the EIP-3529 refund of its transaction. Thus the subsidy subtracts a constant for each slot that a sweep clears or restores. The tests in [Measurement](#measurement) compare these constants with the refund that forge counts.

The subsidy does not subtract a refund of 4,800 gas in two cases. In these cases, `subsidyGas` can be more than `gasUsed`, which [Why farming is prevented](../../../engineering-design-docs/subsidy.md#why-farming-is-prevented) does not allow:
- The payment that empties the subsidy's balance. This occurs once for each top-up.
- A user op that clears storage, for example the slots of a passkey that it replaces. No test limits this case. A passkey replacement in [UserOpSIPA.t.sol](../../test/periphery/UserOpSIPA.t.sol) has a `subsidyGas` that is approximately 118,000 gas more than its `gasUsed`.

## Subsidy gas ceilings

The ceilings in [DepositSubsidy.sol](./DepositSubsidy.sol) limit `subsidyGas`. Below its ceiling, the meter prices an operation. Keep the deposit and registration ceilings, the deploy allowance and the USDC and USDT hops between the chain cost of a representative cold operation and 10% above that cost.

Each calibration test adds a chain-cost offset to the gas that forge counts:
- [DepositSubsidy.executorPath.t.sol](../../test/periphery/DepositSubsidy.executorPath.t.sol) calibrates the deposit ceiling and the deploy allowance against a relayer transaction. Its offset, `HARNESS_TO_CHAIN_RELAY`, comes from the receipts of the `e2e_deposit_subsidy` ladder.
- [DepositSubsidy.executorPath.fork.t.sol](../../test/fork/DepositSubsidy.executorPath.fork.t.sol) calibrates the USDC and USDT hops against relayer transactions that swap through the 3pool: the deposit ceiling and each hop against a resweep, and with the deploy allowance against a first sweep. Its offset, `FORK_TO_CHAIN_RELAY`, is the chain cost of the resweep that `DepositSubsidy.executorPath.t.sol` calibrates the deposit ceiling against, less the gas of the same DAI relayer transaction on the fork.
- [DepositSubsidy.sweepGas.t.sol](../../test/periphery/DepositSubsidy.sweepGas.t.sol) calibrates the registration ceiling against a direct registration sweep. Its offset, `HARNESS_TO_CHAIN` in [SweepGasFixture.sol](../../test/periphery/SweepGasFixture.sol), adds the gas that the deployed contracts use and the test mocks do not. The test also checks that the meter, not the ceiling, prices a cheap relayer transaction.
- [UserOpSIPA.t.sol](../../test/periphery/UserOpSIPA.t.sol) checks that a passkey rotation is below the user op ceiling, and that the ceiling is at most 10% above the chain cost of an add-passkey rotation.
- [SIPA.stableSweep.fork.t.sol](../../test/fork/SIPA.stableSweep.fork.t.sol) measures the USDC and USDT swap allowances on the pinned mainnet fork. The subsidy adds them to the base ceiling.

Calibrate again when the gas of an operation changes.
