// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors as InboxErrors} from "@aztec/core/libraries/Errors.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";

import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {Errors as CoreErrors} from "@core/lib/Errors.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {MigrationExecutor} from "@periphery/migration/MigrationExecutor.sol";
import {MigrationSubsidy} from "@periphery/migration/MigrationSubsidy.sol";
import {Errors} from "@periphery/Errors.sol";

import {MigrationRelay} from "@test/periphery/migration/MigrationRelay.sol";

contract MigrationExecutorTest is MigrationRelay {
  address internal constant TIP_RECIPIENT = address(0x71B);
  uint256 internal constant AMOUNT = 10 ether;
  uint256 internal constant TIP = 1 ether;

  event Migrated(
    IExecutor.Flow flow, bytes32 indexed recipientCommitment, uint256 migrated, address tipRecipient, uint256 relayerTip
  );

  modifier givenTheExecutorHoldsTheAmount() {
    underlying.mint(address(migrationExecutor), AMOUNT);
    _;
  }

  function test_GivenConstructed_ThenImmutablesAreWired() external view {
    assertEq(address(migrationExecutor.SOURCE_PORTAL()), address(portal));
    assertEq(address(migrationExecutor.DESTINATION_PORTAL()), address(destinationPortal));
    assertEq(address(migrationExecutor.ASSET()), address(underlying));
    assertEq(address(migrationExecutor.PAYOUT_TOKEN()), address(payoutToken));
  }

  function test_GivenConstructed_ThenTheDestinationPortalHasAMaxAllowance() external view {
    assertEq(underlying.allowance(address(migrationExecutor), address(destinationPortal)), type(uint256).max);
  }

  function test_GivenConstructed_ThenItCreatesASubsidyBoundToItself() external view {
    MigrationSubsidy subsidy = migrationExecutor.SUBSIDY();
    assertEq(address(subsidy), vm.computeCreateAddress(address(migrationExecutor), 1));
    assertEq(subsidy.SOURCE_PORTAL(), address(portal));
    assertEq(subsidy.DESTINATION_PORTAL(), address(destinationPortal));
    assertEq(subsidy.EXECUTOR(), address(migrationExecutor));
    assertEq(subsidy.OPERATION_EXECUTOR_CODEHASH(), keccak256(type(OperationExecutor).runtimeCode));
    assertEq(address(subsidy.TOKEN()), address(payoutToken));
    assertEq(subsidy.TOKEN_DECIMALS(), 18);
    assertEq(address(subsidy.ASSET()), address(underlying));
    assertEq(address(subsidy.PRICE_FEED()), address(ethUsdFeed));
    assertEq(subsidy.owner(), OWNER);
  }

  function test_GivenASourceWithoutCode_WhenConstructed_ThenReverts() external {
    address noCode = makeAddr("noCode");
    vm.expectRevert(abi.encodeWithSelector(Errors.MigrationExecutor__PortalWithoutCode.selector, noCode));
    _newExecutor(noCode, address(destinationPortal));
  }

  function test_GivenADestinationWithoutCode_WhenConstructed_ThenReverts() external {
    address noCode = makeAddr("noCode");
    vm.expectRevert(abi.encodeWithSelector(Errors.MigrationExecutor__PortalWithoutCode.selector, noCode));
    _newExecutor(address(portal), noCode);
  }

  function test_GivenTheSamePortalTwice_WhenConstructed_ThenReverts() external {
    vm.expectRevert(Errors.MigrationExecutor__SamePortal.selector);
    _newExecutor(address(portal), address(portal));
  }

  function test_GivenPortalsOfDifferentUnderlyings_WhenConstructed_ThenReverts() external {
    OxidePortal otherPortal = _buildPortal(address(new TestERC20("Other", "OTH", address(this))));
    vm.expectRevert(Errors.MigrationExecutor__UnderlyingMismatch.selector);
    _newExecutor(address(portal), address(otherPortal));
  }

  function test_GivenAWithdrawal_ThenTheTipIsPaidAndTheRestIsDeposited() external givenTheExecutorHoldsTheAmount {
    _assertMigrates(IExecutor.Flow.Withdrawal);
  }

  function test_GivenAFrozenNotesRefund_ThenTheTipIsPaidAndTheRestIsDeposited()
    external
    givenTheExecutorHoldsTheAmount
  {
    _assertMigrates(IExecutor.Flow.FrozenNotesRefund);
  }

  function test_GivenAFrozenDepositsRefund_ThenTheTipIsPaidAndTheRestIsDeposited()
    external
    givenTheExecutorHoldsTheAmount
  {
    _assertMigrates(IExecutor.Flow.FrozenDepositsRefund);
  }

  function test_GivenAnUnprocessedDepositRefund_ThenTheTipIsPaidAndTheRestIsDeposited()
    external
    givenTheExecutorHoldsTheAmount
  {
    _assertMigrates(IExecutor.Flow.UnprocessedDepositRefund);
  }

  function test_GivenNoTipAndNoTipRecipient_ThenTheWholeAmountIsDepositedAndTheMigrationIsRecorded()
    external
    givenTheExecutorHoldsTheAmount
  {
    uint256 destinationBefore = _destinationBalance();
    vm.expectCall(
      address(migrationSubsidy), abi.encodeCall(MigrationSubsidy.recordMigration, (IExecutor.Flow.Withdrawal, AMOUNT))
    );

    vm.prank(address(portal));
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal, AMOUNT, _migrationPayload(MIGRATION_COMMITMENT, 0), abi.encodePacked(address(0))
    );

    assertEq(_destinationBalance() - destinationBefore, AMOUNT, "the whole amount is deposited");
    assertEq(underlying.balanceOf(address(migrationExecutor)), 0, "the executor keeps nothing");
  }

  function test_GivenAUserPayloadOfTheWrongLength_ThenReverts() external givenTheExecutorHoldsTheAmount {
    vm.startPrank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__InvalidUserPayload.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal,
      AMOUNT,
      bytes.concat(_migrationPayload(MIGRATION_COMMITMENT, TIP), hex"00"),
      abi.encodePacked(TIP_RECIPIENT)
    );
    vm.expectRevert(Errors.MigrationExecutor__InvalidUserPayload.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal, AMOUNT, abi.encode(MIGRATION_COMMITMENT), abi.encodePacked(TIP_RECIPIENT)
    );
    vm.stopPrank();
  }

  function test_GivenARelayerPayloadOfTheWrongLength_ThenReverts() external givenTheExecutorHoldsTheAmount {
    bytes memory payload = _migrationPayload(MIGRATION_COMMITMENT, TIP);
    vm.startPrank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__InvalidRelayerPayload.selector);
    migrationExecutor.execute(IExecutor.Flow.Withdrawal, AMOUNT, payload, "");
    vm.expectRevert(Errors.MigrationExecutor__InvalidRelayerPayload.selector);
    migrationExecutor.execute(IExecutor.Flow.Withdrawal, AMOUNT, payload, abi.encodePacked(TIP_RECIPIENT, hex"00"));
    vm.expectRevert(Errors.MigrationExecutor__InvalidRelayerPayload.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal, AMOUNT, payload, abi.encodePacked(TIP_RECIPIENT, address(migrationSubsidy))
    );
    vm.stopPrank();
  }

  function test_GivenAZeroRecipientCommitment_ThenReverts() external givenTheExecutorHoldsTheAmount {
    vm.prank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__ZeroRecipientCommitment.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal, AMOUNT, _migrationPayload(bytes32(0), TIP), abi.encodePacked(TIP_RECIPIENT)
    );
  }

  function test_GivenATipAboveTheAmount_ThenReverts() external givenTheExecutorHoldsTheAmount {
    vm.prank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__RelayerTipExceedsAmount.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal,
      AMOUNT,
      _migrationPayload(MIGRATION_COMMITMENT, AMOUNT + 1),
      abi.encodePacked(TIP_RECIPIENT)
    );
  }

  function test_GivenATipWithoutATipRecipient_ThenReverts() external givenTheExecutorHoldsTheAmount {
    vm.prank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__ZeroTipRecipient.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal, AMOUNT, _migrationPayload(MIGRATION_COMMITMENT, TIP), abi.encodePacked(address(0))
    );
  }

  function test_GivenATipOfTheWholeAmount_ThenReverts() external givenTheExecutorHoldsTheAmount {
    vm.prank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__NothingToMigrate.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal,
      AMOUNT,
      _migrationPayload(MIGRATION_COMMITMENT, AMOUNT),
      abi.encodePacked(TIP_RECIPIENT)
    );
  }

  function test_GivenAZeroAmount_ThenReverts() external {
    vm.prank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__NothingToMigrate.selector);
    migrationExecutor.execute(
      IExecutor.Flow.Withdrawal, 0, _migrationPayload(MIGRATION_COMMITMENT, 0), abi.encodePacked(TIP_RECIPIENT)
    );
  }

  function test_GivenACallerOtherThanTheSourcePortal_ThenReverts() external givenTheExecutorHoldsTheAmount {
    bytes memory payload = _migrationPayload(MIGRATION_COMMITMENT, TIP);
    vm.expectRevert(Errors.MigrationExecutor__UnauthorizedCaller.selector);
    migrationExecutor.execute(IExecutor.Flow.Withdrawal, AMOUNT, payload, abi.encodePacked(TIP_RECIPIENT));

    vm.prank(address(destinationPortal));
    vm.expectRevert(Errors.MigrationExecutor__UnauthorizedCaller.selector);
    migrationExecutor.execute(IExecutor.Flow.Withdrawal, AMOUNT, payload, abi.encodePacked(TIP_RECIPIENT));
  }

  function test_GivenAFrozenDestination_ThenTheRefundRevertsAndStaysPending() external givenTeeIsRegistered("tee") {
    _freezeForRefunds();
    destinationRollup.setCheckpoint(DEFAULT_CHECKPOINT_NUMBER, DEFAULT_ARCHIVE_ROOT, 2);
    destinationRollup.setProvenCheckpointNumber(DEFAULT_CHECKPOINT_NUMBER);
    destinationPortal.freeze();
    bytes memory inner = _frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, AMOUNT, TIP, TIP_RECIPIENT);

    _assertRefundStaysPending(inner, abi.encodeWithSelector(CoreErrors.OxidePortal__FrozenPortal.selector));
  }

  function test_GivenACommitmentOutsideTheField_ThenTheRefundRevertsAndStaysPending()
    external
    givenTeeIsRegistered("tee")
  {
    _freezeForRefunds();
    bytes32 commitment = bytes32(Constants.MAX_FIELD_VALUE + 1);
    bytes memory inner = _frozenDepositMigrationCall(1, commitment, AMOUNT, TIP, TIP_RECIPIENT);

    _assertRefundStaysPending(inner, abi.encodeWithSelector(InboxErrors.Inbox__SecretHashTooLarge.selector, commitment));
  }

  function test_GivenATipOfTheWholeRefund_ThenTheRefundRevertsAndStaysPending() external givenTeeIsRegistered("tee") {
    _freezeForRefunds();
    bytes memory inner = _frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, AMOUNT, AMOUNT, TIP_RECIPIENT);

    _assertRefundStaysPending(inner, abi.encodeWithSelector(Errors.MigrationExecutor__NothingToMigrate.selector));
  }

  function _assertMigrates(IExecutor.Flow _flow) internal {
    uint256 destinationBefore = _destinationBalance();
    vm.expectEmit(true, false, false, false, address(destinationPortal));
    emit Deposit(MIGRATION_COMMITMENT, AMOUNT - TIP, bytes32(0), 0);
    vm.expectEmit(address(migrationExecutor));
    emit Migrated(_flow, MIGRATION_COMMITMENT, AMOUNT - TIP, TIP_RECIPIENT, TIP);
    vm.expectCall(address(migrationSubsidy), abi.encodeCall(MigrationSubsidy.recordMigration, (_flow, AMOUNT - TIP)));

    vm.prank(address(portal));
    migrationExecutor.execute(
      _flow, AMOUNT, _migrationPayload(MIGRATION_COMMITMENT, TIP), abi.encodePacked(TIP_RECIPIENT)
    );

    assertEq(underlying.balanceOf(TIP_RECIPIENT), TIP, "the tip recipient gets the tip");
    assertEq(_destinationBalance() - destinationBefore, AMOUNT - TIP, "the rest lands in the new portal");
    assertEq(underlying.balanceOf(address(migrationExecutor)), 0, "the executor keeps nothing");
  }

  function _assertRefundStaysPending(bytes memory _inner, bytes memory _error) internal {
    uint256 sourceBefore = underlying.balanceOf(address(portal));
    uint256 destinationBefore = _destinationBalance();

    (bool ok, bytes memory ret) = address(portal).call(_inner);

    assertFalse(ok, "the refund must revert");
    assertEq(ret, _error, "the destination's revert must bubble up");
    assertFalse(portal.$isRefundNullifierSpent(_depositNullifier(1)), "the refund must stay pending");
    assertEq(underlying.balanceOf(address(portal)), sourceBefore, "the source keeps the funds");
    assertEq(_destinationBalance(), destinationBefore, "the destination gets nothing");
  }

  function _newExecutor(address _source, address _destination) internal returns (MigrationExecutor) {
    return new MigrationExecutor(
      IOxidePortal(_source),
      IOxidePortal(_destination),
      IERC20(address(payoutToken)),
      OWNER,
      keccak256(type(OperationExecutor).runtimeCode),
      ethUsdFeed
    );
  }
}

contract MigrationExecutorSeparatePayoutTokenTest is MigrationRelay {
  address internal constant TIP_RECIPIENT = address(0x71B);
  uint256 internal constant AMOUNT = 10 ether;
  uint256 internal constant TIP = 1 ether;

  function test_GivenAPayoutTokenOtherThanTheAsset_WhenATipIsSet_ThenReverts() external {
    underlying.mint(address(migrationExecutor), AMOUNT);

    vm.prank(address(portal));
    vm.expectRevert(Errors.MigrationExecutor__TipNotInPayoutToken.selector);
    migrationExecutor.execute(
      IExecutor.Flow.FrozenNotesRefund,
      AMOUNT,
      _migrationPayload(MIGRATION_COMMITMENT, TIP),
      abi.encodePacked(TIP_RECIPIENT)
    );
  }

  function test_GivenAPayoutTokenOtherThanTheAsset_WhenNoTipIsSet_ThenTheWholeAmountIsDeposited() external {
    underlying.mint(address(migrationExecutor), AMOUNT);
    uint256 destinationBefore = underlying.balanceOf(address(destinationPortal));

    vm.prank(address(portal));
    migrationExecutor.execute(
      IExecutor.Flow.FrozenNotesRefund,
      AMOUNT,
      _migrationPayload(MIGRATION_COMMITMENT, 0),
      abi.encodePacked(TIP_RECIPIENT)
    );

    assertEq(underlying.balanceOf(address(destinationPortal)) - destinationBefore, AMOUNT, "the whole amount lands");
    assertEq(underlying.balanceOf(TIP_RECIPIENT), 0, "no tip is paid");
  }

  function test_GivenAPayoutTokenOtherThanTheAsset_WhenARefundWithATipIsRelayed_ThenTheRefundStaysPending()
    external
    givenTeeIsRegistered("tee")
  {
    _freezeForRefunds();
    bytes memory inner = _frozenDepositMigrationCall(1, MIGRATION_COMMITMENT, AMOUNT, TIP, address(operationExecutor));
    uint256 sourceBefore = underlying.balanceOf(address(portal));

    vm.expectRevert(Errors.MigrationExecutor__TipNotInPayoutToken.selector);
    vm.prank(MIGRATION_RELAYER, MIGRATION_RELAYER);
    operationExecutor.execute(address(migrationSubsidy), inner, payoutToken, 0, 0, 0);

    assertFalse(portal.$isRefundNullifierSpent(_depositNullifier(1)), "the refund stays pending");
    assertEq(underlying.balanceOf(address(portal)), sourceBefore, "the source keeps the funds");
  }

  function _separatePayoutToken() internal pure override returns (bool) {
    return true;
  }
}
