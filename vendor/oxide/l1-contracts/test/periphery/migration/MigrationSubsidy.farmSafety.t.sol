// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {MigrationSubsidy} from "@periphery/migration/MigrationSubsidy.sol";
import {Errors} from "@periphery/Errors.sol";

import {MigrationRelay} from "@test/periphery/migration/MigrationRelay.sol";
import {V5MigrationRelay} from "@test/periphery/migration/v5/V5MigrationRelay.sol";
import {V5Errors} from "@test/periphery/migration/v5/V5Errors.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";

contract MigrationBatch {
  function relayAll(MigrationSubsidy _subsidy, bytes[] calldata _calls) external {
    for (uint256 i = 0; i < _calls.length; i++) {
      (bool ok, bytes memory ret) = address(_subsidy).call(_calls[i]);
      if (!ok) {
        assembly ("memory-safe") {
          revert(add(ret, 32), mload(ret))
        }
      }
    }
  }
}

contract BundlingRelayer {
  uint256[] internal $work;

  function relay(OperationExecutor _executor, address _target, bytes calldata _data, IERC20 _payoutToken, uint256 _work)
    external
  {
    for (uint256 i = 0; i < _work; i++) {
      $work.push(i + 1);
    }
    _executor.execute(_target, _data, _payoutToken, 0, 0, 0);
  }
}

contract RevisedOperationExecutor is OperationExecutor {
  function revision() external pure returns (uint256) {
    return 2;
  }
}

contract MigrationSubsidyFarmSafetyTest is MigrationRelay {
  address internal constant FARMER = address(0xFA12);
  uint256 internal constant WITHDRAWAL_MIGRATED = MIGRATION_AMOUNT - MIGRATION_PROVER_TIP - MIGRATION_TIP;
  uint256 internal constant REFUND_MIGRATED = MIGRATION_AMOUNT - MIGRATION_TIP;

  MigrationBatch internal batch;
  BundlingRelayer internal bundler;

  function setUp() public virtual override {
    super.setUp();
    batch = new MigrationBatch();
    bundler = new BundlingRelayer();
  }

  function test_GivenARelayerTransaction_ThenTheMigrationIsPaid() external givenTeeIsRegistered("tee") {
    bytes memory inner = _withdrawal(address(operationExecutor));
    assertTrue(portal.$frozen(), "the source is frozen");
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(FARMER, address(migrationSubsidy), inner);

    uint256 paid = potBefore - _pot();
    assertGt(paid, 0, "a relayer transaction is paid the subsidy");
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP + paid, "the relayer gets the tip and the subsidy");
    assertEq(_destinationBalance() - destinationBefore, WITHDRAWAL_MIGRATED, "the rest lands in the new portal");
  }

  function test_GivenAnUnfrozenSource_WhenAWithdrawalIsRelayed_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    freezeSourceForWithdrawals = false;
    bytes memory inner = _withdrawal(address(operationExecutor));
    assertFalse(portal.$frozen(), "the source is live");
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(FARMER, address(migrationSubsidy), inner);

    _assertMigratedUnpaid(potBefore, destinationBefore, WITHDRAWAL_MIGRATED);
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP, "the relayer gets the tip alone");
  }

  function test_GivenADirectCallToThePortal_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    bytes memory inner = _withdrawal(FARMER);
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    vm.prank(FARMER, FARMER);
    (bool ok,) = address(portal).call(inner);

    assertTrue(ok, "the direct migration must land");
    _assertMigratedUnpaid(potBefore, destinationBefore, WITHDRAWAL_MIGRATED);
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP, "the direct caller gets the tip alone");
  }

  function test_GivenTheExecutorTargetingThePortal_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    bytes memory inner = _withdrawal(address(operationExecutor));
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(FARMER, address(portal), inner);

    _assertMigratedUnpaid(potBefore, destinationBefore, WITHDRAWAL_MIGRATED);
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP, "the relayer gets the tip alone");
  }

  function test_GivenABatchThroughTheExecutor_ThenItReverts() external givenTeeIsRegistered("tee") {
    _freezeForRefunds();
    bytes[] memory calls = new bytes[](2);
    calls[0] = _frozenNotesMigrationCall(
      1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, MIGRATION_TIP, address(operationExecutor), 1
    );
    calls[1] = _frozenNotesMigrationCall(
      2, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, MIGRATION_TIP, address(operationExecutor), 1
    );

    vm.expectRevert(abi.encodeWithSelector(Errors.MigrationSubsidy__NotOperationExecutor.selector, address(batch)));
    _execute(FARMER, address(batch), abi.encodeCall(MigrationBatch.relayAll, (migrationSubsidy, calls)));
  }

  function test_GivenAContractCaller_ThenTheMigrationLandsAndThePotIsUntouched() external givenTeeIsRegistered("tee") {
    bytes memory inner = _withdrawal(address(operationExecutor));
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(address(batch), FARMER, address(migrationSubsidy), inner);

    _assertMigratedUnpaid(potBefore, destinationBefore, WITHDRAWAL_MIGRATED);
    assertEq(underlying.balanceOf(address(batch)), MIGRATION_TIP, "the contract gets the tip alone");
  }

  function test_GivenADelegatedEOA_ThenTheMigrationLandsAndThePotIsUntouched() external givenTeeIsRegistered("tee") {
    vm.etch(FARMER, abi.encodePacked(hex"ef0100", address(batch)));
    bytes memory inner = _withdrawal(address(operationExecutor));
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(FARMER, address(migrationSubsidy), inner);

    _assertMigratedUnpaid(potBefore, destinationBefore, WITHDRAWAL_MIGRATED);
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP, "the delegated EOA gets the tip alone");
  }

  function test_GivenAnotherPayoutToken_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    bytes memory inner = _withdrawal(address(operationExecutor));
    IERC20 otherToken = IERC20(address(new TestERC20("Other", "OTH", address(this))));
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    vm.prank(FARMER, FARMER);
    operationExecutor.execute(address(migrationSubsidy), inner, otherToken, 0, 0, 0);

    _assertMigratedUnpaid(potBefore, destinationBefore, WITHDRAWAL_MIGRATED);
  }

  function test_GivenATipRecipientOtherThanTheExecutor_ThenTheRelayerIsPaidNoMoreThanItsGas()
    external
    givenTeeIsRegistered("tee")
  {
    address tipRecipient = makeAddr("tipRecipient");
    bytes memory inner = _withdrawal(tipRecipient);
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    (uint256 txGas, uint256 priced) = _relay(inner);

    assertGt(potBefore - _pot(), 0, "the relayer is paid the subsidy");
    assertLe(priced, txGas, "the subsidy pays more gas than the relay uses");
    assertEq(underlying.balanceOf(tipRecipient), MIGRATION_TIP, "the tip recipient gets the tip");
    assertEq(_destinationBalance() - destinationBefore, WITHDRAWAL_MIGRATED, "the rest lands in the new portal");
  }

  function test_GivenAnExitThroughAnotherExecutor_ThenTheExitLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    address recipient = makeAddr("plainRecipient");
    bytes memory inner = _migrationWithdrawCallOf(
      address(plainWithdrawalExecutor),
      bytes32(uint256(uint160(recipient))),
      MIGRATION_AMOUNT,
      MIGRATION_TIP,
      address(operationExecutor),
      MIGRATION_WITHDRAWAL_PATH_DEPTH,
      keccak256("plainExit")
    );
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(FARMER, address(migrationSubsidy), inner);

    assertEq(underlying.balanceOf(recipient), WITHDRAWAL_MIGRATED, "the plain exit must still land");
    _assertMigratedUnpaid(potBefore, destinationBefore, 0);
  }

  function test_GivenAnotherOperationExecutorWithTheSameCode_ThenItsRelayerTransactionIsPaid()
    external
    givenTeeIsRegistered("tee")
  {
    OperationExecutor other = new OperationExecutor();
    bytes memory inner = _withdrawal(address(other));
    uint256 potBefore = _pot();

    vm.prank(FARMER, FARMER);
    other.execute(address(migrationSubsidy), inner, payoutToken, 0, 0, 0);

    assertGt(potBefore - _pot(), 0, "every OperationExecutor runs the same code, so each one's relays are paid");
  }

  function test_GivenAnExecutorWithOtherCode_ThenItReverts() external givenTeeIsRegistered("tee") {
    OperationExecutor other = new RevisedOperationExecutor();
    bytes memory inner = _withdrawal(address(other));

    vm.expectRevert(abi.encodeWithSelector(Errors.MigrationSubsidy__NotOperationExecutor.selector, address(other)));
    vm.prank(FARMER, FARMER);
    other.execute(address(migrationSubsidy), inner, payoutToken, 0, 0, 0);
  }

  function test_GivenAMigratedAmountUnderTheFloor_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    vm.prank(OWNER);
    migrationSubsidy.setConfig(0, type(uint128).max, uint128(REFUND_MIGRATED + 1));
    _freezeForRefunds();
    bytes memory inner =
      _frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, MIGRATION_TIP, address(operationExecutor));
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(FARMER, address(migrationSubsidy), inner);

    _assertMigratedUnpaid(potBefore, destinationBefore, REFUND_MIGRATED);
  }

  function test_GivenAMigratedAmountAtTheFloor_ThenTheMigrationIsPaid() external givenTeeIsRegistered("tee") {
    vm.prank(OWNER);
    migrationSubsidy.setConfig(0, type(uint128).max, uint128(REFUND_MIGRATED));
    _freezeForRefunds();
    bytes memory inner =
      _frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, MIGRATION_TIP, address(operationExecutor));
    uint256 potBefore = _pot();

    _execute(FARMER, address(migrationSubsidy), inner);

    assertGt(potBefore - _pot(), 0, "a migration at the floor is paid");
  }

  function test_GivenAReplayedMigration_ThenTheRelayRevertsAndThePotIsUntouched() external givenTeeIsRegistered("tee") {
    bytes memory inner = _withdrawal(address(operationExecutor));
    _execute(FARMER, address(migrationSubsidy), inner);
    uint256 potBefore = _pot();

    vm.prank(FARMER, FARMER);
    (bool ok,) = address(operationExecutor)
      .call(abi.encodeCall(OperationExecutor.execute, (address(migrationSubsidy), inner, payoutToken, 0, 0, 0)));

    assertFalse(ok, "a replayed migration must revert");
    assertEq(_pot(), potBefore, "the pot must be untouched");
  }

  function test_GivenARelayedRefund_ThenItIsPaid() external givenTeeIsRegistered("tee") {
    _freezeForRefunds();
    bytes memory inner = _frozenNotesMigrationCall(
      1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, MIGRATION_TIP, address(operationExecutor), 1
    );
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _execute(FARMER, address(migrationSubsidy), inner);

    uint256 paid = potBefore - _pot();
    assertGt(paid, 0, "a relayer transaction is paid the refund subsidy");
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP + paid, "the relayer gets the tip and the subsidy");
    assertEq(_destinationBalance() - destinationBefore, REFUND_MIGRATED, "the rest lands in the new portal");
  }

  function test_GivenADirectRefund_ThenTheRefundLandsAndThePotIsUntouched() external givenTeeIsRegistered("tee") {
    _freezeForRefunds();
    bytes memory inner = _frozenNotesMigrationCall(1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, MIGRATION_TIP, FARMER, 1);
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    vm.prank(FARMER, FARMER);
    (bool ok,) = address(portal).call(inner);

    assertTrue(ok, "the direct refund must land");
    _assertMigratedUnpaid(potBefore, destinationBefore, REFUND_MIGRATED);
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP, "the direct caller gets the tip alone");
  }

  function test_GivenNonRefundingWorkBundledInTheTransaction_ThenThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    bytes memory inner = _withdrawal(address(operationExecutor));
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    vm.prank(FARMER, FARMER);
    bundler.relay(operationExecutor, address(migrationSubsidy), inner, payoutToken, 20);

    _assertMigratedUnpaid(potBefore, destinationBefore, WITHDRAWAL_MIGRATED);
  }

  function test_GivenCalldataAppendedUnderTheCeiling_ThenTheSubsidyPaysItBackAndNoMore()
    external
    givenTeeIsRegistered("tee")
  {
    (uint256 txGas, uint256 priced) = _relayPadded(_withdrawal(address(operationExecutor)), 2000);

    assertLt(
      priced, migrationSubsidy.migrationGasCeiling(IExecutor.Flow.Withdrawal), "the padded relay is under the ceiling"
    );
    assertLe(priced, txGas, "the subsidy pays more gas than the padded relay uses");
    assertGe(priced + PRICED_MIGRATION_TOLERANCE, txGas, "the subsidy does not pay the appended calldata back");
  }

  function test_GivenCalldataAppendedPastTheCeiling_ThenThePaymentStopsAtTheCeiling()
    external
    givenTeeIsRegistered("tee")
  {
    (uint256 txGas, uint256 priced) = _relayPadded(_withdrawal(address(operationExecutor)), 8000);

    uint256 ceiling = migrationSubsidy.migrationGasCeiling(IExecutor.Flow.Withdrawal);
    assertGt(txGas, ceiling, "the padded relay uses more gas than the ceiling");
    assertEq(priced, ceiling, "padding past the ceiling is priced at the ceiling");
  }

  function _relayPadded(bytes memory _inner, uint256 _padding) internal returns (uint256 txGas, uint256 priced) {
    bytes memory padding = new bytes(_padding);
    for (uint256 i = 0; i < _padding; i++) {
      padding[i] = 0xff;
    }
    bytes memory outer = abi.encodeCall(
      OperationExecutor.execute, (address(migrationSubsidy), bytes.concat(_inner, padding), payoutToken, 0, 0, 0)
    );
    uint256 potBefore = _pot();
    _coolEveryAccountOfTheRelay(address(operationExecutor), MIGRATION_RELAYER);
    vm.prank(MIGRATION_RELAYER, MIGRATION_RELAYER);
    (bool ok,) = address(operationExecutor).call(outer);
    require(ok, "the padded relay reverted");
    txGas = RelayerTransaction.lastTxGas(outer);
    priced = _pricedGasOf(potBefore - _pot());
  }

  function _withdrawal(address _tipRecipient) internal returns (bytes memory) {
    return _migrationWithdrawCall(MIGRATION_COMMITMENT, MIGRATION_TIP, _tipRecipient, MIGRATION_WITHDRAWAL_PATH_DEPTH);
  }

  function _assertMigratedUnpaid(uint256 _potBefore, uint256 _destinationBefore, uint256 _migrated) internal view {
    assertEq(_destinationBalance() - _destinationBefore, _migrated, "the migration must still land");
    assertEq(_pot(), _potBefore, "the pot must be untouched");
  }

  function _execute(address _from, address _target, bytes memory _data) internal {
    _execute(_from, _from, _target, _data);
  }

  function _execute(address _sender, address _origin, address _target, bytes memory _data) internal {
    vm.prank(_sender, _origin);
    operationExecutor.execute(_target, _data, payoutToken, 0, 0, 0);
  }
}

contract MigrationSubsidyV5UnfrozenSourceTest is V5MigrationRelay {
  function test_GivenAnUnfrozenV5Source_WhenARefundIsRelayed_ThenItRevertsAndNothingMoves() external {
    bytes memory inner = _v5FrozenDepositCall(1, MIGRATION_AMOUNT, _relayTip(), address(operationExecutor));
    uint256 potBefore = payoutToken.balanceOf(address(v5Subsidy));
    uint256 sourceBefore = underlying.balanceOf(address(v5Portal));
    uint256 destinationBefore = _destinationBalance();

    vm.expectRevert(V5Errors.OxidePortal__NotFrozen.selector);
    vm.prank(MIGRATION_RELAYER, MIGRATION_RELAYER);
    operationExecutor.execute(address(v5Subsidy), inner, payoutToken, 0, 0, 0);

    assertEq(payoutToken.balanceOf(address(v5Subsidy)), potBefore, "the pot must be untouched");
    assertEq(underlying.balanceOf(address(v5Portal)), sourceBefore, "the v5 portal keeps the funds");
    assertEq(_destinationBalance(), destinationBefore, "the destination gets nothing");
    assertFalse(v5Portal.$isRefundNullifierSpent(_depositNullifier(1)), "the refund stays pending");
  }

  function test_GivenAnUnfrozenV5Source_WhenAWithdrawalIsRelayed_ThenTheMigrationLandsAndThePotIsUntouched() external {
    uint256 potBefore = payoutToken.balanceOf(address(v5Subsidy));
    uint256 destinationBefore = _destinationBalance();

    _v5Relay(v5Withdrawal);

    assertEq(payoutToken.balanceOf(address(v5Subsidy)), potBefore, "an unfrozen source is not paid");
    assertEq(
      _destinationBalance() - destinationBefore,
      MIGRATION_AMOUNT - MIGRATION_PROVER_TIP - V5_FPC_FUNDING_CUT - _relayTip(),
      "the migration lands in the new portal"
    );
  }

  function _freezeV5Source() internal pure override returns (bool) {
    return false;
  }
}
