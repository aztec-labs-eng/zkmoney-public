// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";

import {MigrationRelay} from "@test/periphery/migration/MigrationRelay.sol";
import {V5MigrationRelay} from "@test/periphery/migration/v5/V5MigrationRelay.sol";
import {V5OxideConstants} from "@test/periphery/migration/v5/V5OxideConstants.sol";

abstract contract CeilingAssertions is Test {
  uint256 internal constant MIN_CEILING_HEADROOM_PERCENT = 110;
  uint256 internal constant MAX_CEILING_HEADROOM_PERCENT = 125;

  function _assertCeilingHasHeadroom(uint256 _ceiling, uint256 _chainCost) internal pure {
    console2.log("chain cost", _chainCost, "ceiling", _ceiling);
    assertGe(
      _ceiling,
      (_chainCost * MIN_CEILING_HEADROOM_PERCENT) / 100,
      "the ceiling has less than 10% headroom over the chain cost"
    );
  }

  function _assertCeilingIsCalibrated(uint256 _ceiling, uint256 _chainCost) internal pure {
    _assertCeilingHasHeadroom(_ceiling, _chainCost);
    assertLe(
      _ceiling, (_chainCost * MAX_CEILING_HEADROOM_PERCENT) / 100, "the ceiling is far above an honest migration"
    );
  }
}

abstract contract MigrationRelayedExitFixture is MigrationRelay, CeilingAssertions {
  uint256 internal constant BUSY_CHECKPOINT_PATH_DEPTH = 12;
  uint256 internal constant DEEPEST_WITHDRAWAL_PATH_DEPTH = 20;

  function _relayWithdrawalAtDepth(uint256 _depth) internal returns (uint256 txGas, uint256 priced) {
    return _relay(_migrationWithdrawCall(MIGRATION_COMMITMENT, _relayTip(), address(operationExecutor), _depth));
  }

  function _relayFrozenNotes(uint256 _notes) internal returns (uint256 txGas, uint256 priced) {
    _freezeForRefunds();
    return _relay(
      _frozenNotesMigrationCall(
        1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, _relayTip(), address(operationExecutor), _notes
      )
    );
  }

  function _relayFrozenDeposit() internal returns (uint256 txGas, uint256 priced) {
    _freezeForRefunds();
    return _relay(
      _frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, _relayTip(), address(operationExecutor))
    );
  }

  function _relayUnprocessedDeposit() internal returns (uint256 txGas, uint256 priced) {
    _freezeForRefunds();
    return _relay(
      _unprocessedDepositMigrationCall(1, MIGRATION_COMMITMENT, 10 ether, _relayTip(), address(operationExecutor))
    );
  }
}

contract MigrationSubsidyRelayedExitTest is MigrationRelayedExitFixture {
  function test_GivenAWithdrawalAtTheShallowestPath_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayWithdrawalAtDepth(MIGRATION_WITHDRAWAL_PATH_DEPTH);
    _assertPaysItsGas("withdrawal, shallowest path", txGas, priced);
  }

  function test_GivenAWithdrawalFromABusyCheckpoint_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayWithdrawalAtDepth(BUSY_CHECKPOINT_PATH_DEPTH);
    _assertPaysItsGas("withdrawal, busy checkpoint", txGas, priced);
  }

  function test_GivenAWithdrawalWithNoTip_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relay(
      _migrationWithdrawCall(MIGRATION_COMMITMENT, 0, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH)
    );
    _assertPaysItsGas("withdrawal, no tip", txGas, priced);
  }

  function test_GivenARefundWithNoTip_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    _freezeForRefunds();
    (uint256 txGas, uint256 priced) =
      _relay(_frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, 0, address(operationExecutor)));
    _assertPaysItsGas("frozen deposit refund, no tip", txGas, priced);
  }

  function test_GivenARefundWithNoTipRecipient_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    _freezeForRefunds();
    (uint256 txGas, uint256 priced) =
      _relay(_frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, 0, address(0)));
    _assertPaysItsGas("frozen deposit refund, no tip recipient", txGas, priced);
  }

  function test_GivenAOneNoteFrozenNotesRefund_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayFrozenNotes(1);
    _assertPaysItsGas("frozen notes refund, one note", txGas, priced);
    console2.log("frozen notes refund verification gas", _frozenNotesVerificationGas());
  }

  function test_GivenAFrozenNotesRefundOfTheMostNotes_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayFrozenNotes(OxideConstants.MAX_FROZEN_NOTES_PER_REFUND);
    _assertPaysItsGas("frozen notes refund, most notes", txGas, priced);
  }

  function test_GivenAFrozenDepositsRefund_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayFrozenDeposit();
    _assertPaysItsGas("frozen deposit refund", txGas, priced);
    console2.log("frozen deposit refund verification gas", _frozenDepositVerificationGas());
  }

  function test_GivenAnUnprocessedDepositRefund_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayUnprocessedDeposit();
    _assertPaysItsGas("unprocessed deposit refund", txGas, priced);
  }

  function test_GivenAMigrationThatClearsTheDestinationRateLimit_ThenTheSubsidyPaysItsGas()
    external
    givenTeeIsRegistered("tee")
  {
    bytes memory inner = _migrationWithdrawCall(
      MIGRATION_COMMITMENT, _relayTip(), address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH
    );
    _useDestinationLimitDownTo(MIGRATION_AMOUNT - MIGRATION_PROVER_TIP - _relayTip());

    (uint256 txGas, uint256 priced) = _relay(inner);

    assertEq(destinationPortal.$cachedAvailable(), 0, "the migration clears the destination's rate limit slot");
    _assertPaysItsGas("withdrawal, clears the destination rate limit", txGas, priced);
  }

  function test_GivenTheDeepestWithdrawal_ThenTheCeilingCoversItsChainCost() external givenTeeIsRegistered("tee") {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayWithdrawalAtDepth(DEEPEST_WITHDRAWAL_PATH_DEPTH);
    _assertCeilingCovers(IExecutor.Flow.Withdrawal, txGas + HARNESS_TO_CHAIN_MIGRATION_RELAY);
  }

  function test_GivenAFrozenNotesRefundOfTheMostNotes_ThenTheCeilingCoversItsChainCost()
    external
    givenTeeIsRegistered("tee")
  {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrozenNotes(OxideConstants.MAX_FROZEN_NOTES_PER_REFUND);
    console2.log("frozen notes refund, most notes, new inbox bucket, tx gas", txGas);
    _assertCeilingCovers(
      IExecutor.Flow.FrozenNotesRefund, txGas + _frozenNotesVerificationGas() + HARNESS_TO_CHAIN_MIGRATION_RELAY
    );
  }

  function test_GivenAFrozenDepositsRefund_ThenTheCeilingCoversItsChainCost() external givenTeeIsRegistered("tee") {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrozenDeposit();
    console2.log("frozen deposit refund, new inbox bucket, tx gas", txGas);
    _assertCeilingCovers(
      IExecutor.Flow.FrozenDepositsRefund, txGas + _frozenDepositVerificationGas() + HARNESS_TO_CHAIN_MIGRATION_RELAY
    );
  }

  function test_GivenAnUnprocessedDepositRefund_ThenTheCeilingCoversItsChainCost()
    external
    givenTeeIsRegistered("tee")
  {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayUnprocessedDeposit();
    _assertCeilingCovers(
      IExecutor.Flow.UnprocessedDepositRefund,
      txGas + _unprocessedDepositVerificationGas() + HARNESS_TO_CHAIN_MIGRATION_RELAY
    );
  }

  function _useDestinationLimitDownTo(uint256 _left) internal {
    address whale = makeAddr("destinationWhale");
    uint256 toUse = destinationPortal.getCurrentAvailable() - _left;
    underlying.mint(whale, toUse);
    vm.startPrank(whale);
    underlying.approve(address(destinationPortal), type(uint256).max);
    while (toUse > 0) {
      uint256 chunk = toUse > TX_AMOUNT_CAP ? TX_AMOUNT_CAP : toUse;
      destinationPortal.deposit(bytes32(uint256(0xD00D)), chunk);
      toUse -= chunk;
    }
    vm.stopPrank();
    assertEq(destinationPortal.getCurrentAvailable(), _left, "the destination has exactly the migration left");
  }

  function _assertCeilingCovers(IExecutor.Flow _flow, uint256 _chainCost) internal view {
    _assertCeilingHasHeadroom(migrationSubsidy.migrationGasCeiling(_flow), _chainCost);
  }
}

contract MigrationSubsidyRelayedExitSeparatePayoutTokenTest is MigrationSubsidyRelayedExitTest {
  function _separatePayoutToken() internal pure override returns (bool) {
    return true;
  }
}

contract MigrationSubsidyRelayerWithNoTokenTest is MigrationRelayedExitFixture {
  function test_GivenARelayerWithNoToken_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayWithdrawalAtDepth(MIGRATION_WITHDRAWAL_PATH_DEPTH);
    _assertPaysItsGas("withdrawal, relayer with no token", txGas, priced);
  }

  function test_GivenARelayerWithNoToken_WhenARefundIsRelayed_ThenTheSubsidyPaysItsGas()
    external
    givenTeeIsRegistered("tee")
  {
    (uint256 txGas, uint256 priced) = _relayFrozenDeposit();
    _assertPaysItsGas("frozen deposit refund, relayer with no token", txGas, priced);
  }

  function _relayerHoldsToken() internal pure override returns (bool) {
    return false;
  }
}

contract MigrationSubsidyOperationExecutorHoldsTokenTest is MigrationRelayedExitFixture {
  function setUp() public override {
    super.setUp();
    _mintPayout(address(operationExecutor), 1);
  }

  function test_GivenAnOperationExecutorThatHoldsTheToken_ThenTheSubsidyPaysItsGas()
    external
    givenTeeIsRegistered("tee")
  {
    (uint256 txGas, uint256 priced) = _relayWithdrawalAtDepth(MIGRATION_WITHDRAWAL_PATH_DEPTH);
    _assertPaysItsGas("withdrawal, operation executor holds the token", txGas, priced);
  }

  function test_GivenAnOperationExecutorThatHoldsTheToken_WhenTheTipIsZero_ThenTheSubsidyPaysItsGas()
    external
    givenTeeIsRegistered("tee")
  {
    (uint256 txGas, uint256 priced) = _relay(
      _migrationWithdrawCall(MIGRATION_COMMITMENT, 0, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH)
    );
    _assertPaysItsGas("withdrawal, operation executor holds the token, no tip", txGas, priced);
  }

  function test_GivenAnOperationExecutorThatHoldsTheToken_WhenARefundIsRelayed_ThenTheSubsidyPaysItsGas()
    external
    givenTeeIsRegistered("tee")
  {
    (uint256 txGas, uint256 priced) = _relayFrozenDeposit();
    _assertPaysItsGas("frozen deposit refund, operation executor holds the token", txGas, priced);
  }
}

contract MigrationSubsidyMigrationExecutorHoldsAssetTest is MigrationRelayedExitFixture {
  function setUp() public override {
    super.setUp();
    underlying.mint(address(migrationExecutor), 1);
  }

  function test_GivenAMigrationExecutorThatHoldsTheAsset_ThenTheSubsidyPaysItsGas()
    external
    givenTeeIsRegistered("tee")
  {
    (uint256 txGas, uint256 priced) = _relayWithdrawalAtDepth(MIGRATION_WITHDRAWAL_PATH_DEPTH);
    _assertPaysItsGas("withdrawal, migration executor holds the asset", txGas, priced);
  }
}

contract MigrationSubsidyV5SourceTest is V5MigrationRelay, CeilingAssertions {
  function test_GivenAV5Withdrawal_ThenTheSubsidyPaysItsGas() external {
    (uint256 txGas, uint256 priced) = _v5Relay(v5Withdrawal);
    _assertPaysItsGas("v5 withdrawal, deepest path", txGas, priced);
  }

  function test_GivenAV5OneNoteFrozenNotesRefund_ThenTheSubsidyPaysItsGas() external {
    (uint256 txGas, uint256 priced) =
      _v5Relay(_v5FrozenNotesCall(1, MIGRATION_AMOUNT, _relayTip(), address(operationExecutor), 1));
    _assertPaysItsGas("v5 frozen notes refund, one note", txGas, priced);
  }

  function test_GivenAV5FrozenNotesRefundOfTheMostNotes_ThenTheSubsidyPaysItsGas() external {
    (uint256 txGas, uint256 priced) = _relayV5MostNotes();
    _assertPaysItsGas("v5 frozen notes refund, most notes", txGas, priced);
  }

  function test_GivenAV5FrozenDepositRefund_ThenTheSubsidyPaysItsGas() external {
    (uint256 txGas, uint256 priced) =
      _v5Relay(_v5FrozenDepositCall(1, MIGRATION_AMOUNT, _relayTip(), address(operationExecutor)));
    _assertPaysItsGas("v5 frozen deposit refund", txGas, priced);
  }

  function test_GivenAV5UnprocessedDepositRefund_ThenTheSubsidyPaysItsGas() external {
    (uint256 txGas, uint256 priced) = _v5Relay(_v5UnprocessedDepositCall(1, _relayTip(), address(operationExecutor)));
    _assertPaysItsGas("v5 unprocessed deposit refund", txGas, priced);
  }

  function test_GivenAV5UnprocessedDepositRefund_ThenTheRefundLandsInTheDestination() external {
    uint256 destinationBefore = underlying.balanceOf(address(destinationPortal));
    uint256 potBefore = payoutToken.balanceOf(address(v5Subsidy));

    _v5Relay(_v5UnprocessedDepositCall(1, _relayTip(), address(operationExecutor)));

    assertTrue(v5Portal.$isRefundNullifierSpent(_unprocessedNullifier(1)), "the v5 refund nullifier is spent");
    assertEq(
      underlying.balanceOf(address(destinationPortal)) - destinationBefore,
      V5_DEPOSIT_AMOUNT - V5_FPC_FUNDING_CUT - _relayTip(),
      "the refund lands in the new portal"
    );
    assertGt(_v5PotPaid(potBefore), 0, "the relay is paid");
  }

  function test_GivenTheDeepestV5Withdrawal_ThenTheCeilingCoversItsChainCost() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _v5Relay(v5Withdrawal);
    _assertCeilingHasHeadroom(
      v5Subsidy.migrationGasCeiling(IExecutor.Flow.Withdrawal), txGas + HARNESS_TO_CHAIN_MIGRATION_RELAY
    );
  }

  function test_GivenAV5FrozenNotesRefundOfTheMostNotes_ThenTheCeilingIsCalibrated() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayV5MostNotes();
    _assertCeilingIsCalibrated(
      v5Subsidy.migrationGasCeiling(IExecutor.Flow.FrozenNotesRefund),
      txGas + _frozenNotesVerificationGas() + HARNESS_TO_CHAIN_MIGRATION_RELAY
    );
  }

  function test_GivenAV5FrozenDepositRefund_ThenTheCeilingIsCalibrated() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _v5Relay(_v5FrozenDepositCall(1, MIGRATION_AMOUNT, _relayTip(), address(operationExecutor)));
    _assertCeilingIsCalibrated(
      v5Subsidy.migrationGasCeiling(IExecutor.Flow.FrozenDepositsRefund),
      txGas + _frozenDepositVerificationGas() + HARNESS_TO_CHAIN_MIGRATION_RELAY
    );
  }

  function test_GivenAV5UnprocessedDepositRefund_ThenTheCeilingIsCalibrated() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _v5Relay(_v5UnprocessedDepositCall(1, _relayTip(), address(operationExecutor)));
    _assertCeilingIsCalibrated(
      v5Subsidy.migrationGasCeiling(IExecutor.Flow.UnprocessedDepositRefund),
      txGas + _unprocessedDepositVerificationGas() + HARNESS_TO_CHAIN_MIGRATION_RELAY
    );
  }

  function _relayV5MostNotes() internal returns (uint256 txGas, uint256 priced) {
    return _v5Relay(
      _v5FrozenNotesCall(
        1, MIGRATION_AMOUNT, _relayTip(), address(operationExecutor), V5OxideConstants.MAX_FROZEN_NOTES_PER_REFUND
      )
    );
  }
}

contract MigrationSubsidyV5SourceSeparatePayoutTokenTest is MigrationSubsidyV5SourceTest {
  function _separatePayoutToken() internal pure override returns (bool) {
    return true;
  }
}
