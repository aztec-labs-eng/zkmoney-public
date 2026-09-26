# Periphery contracts

## Subsidy gas ceilings

The ceilings in [DepositSubsidy.sol](./DepositSubsidy.sol) bound gas reimbursement while covering typical operations. Keep each base ceiling between the estimated chain cost of a representative standalone cold operation and 10% above that cost. Use measured gas to price operations that fall below the ceiling.

Calibration must reflect standalone chain cost for each materially different authorization path. [DepositSubsidy.sweepGas.t.sol](../../test/periphery/DepositSubsidy.sweepGas.t.sol) is the canonical executable calibration and policy test. The chain-cost correction in [SweepGasFixture.sol](../../test/periphery/SweepGasFixture.sol) accounts for test mocks being cheaper than deployed contracts. Recalibrate when operation costs change.

USDC and USDT swap allowances cover the additional cost of conversion and are added to the base ceiling. They are measured separately by the pinned mainnet fork tests in [SIPA.stableSweep.fork.t.sol](../../test/fork/SIPA.stableSweep.fork.t.sol).
