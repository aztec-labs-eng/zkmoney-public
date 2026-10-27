// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Ownable} from "@oz/access/Ownable.sol";
import {IERC20 as IERC20OZ} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@oz/interfaces/draft-IERC6093.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors as CoreErrors} from "@core/lib/Errors.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {MigrationSubsidy} from "@periphery/migration/MigrationSubsidy.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {Errors} from "@periphery/Errors.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";

import {MigrationRelay} from "@test/periphery/migration/MigrationRelay.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

contract MigrationSubsidyTest is MigrationRelay {
  uint256 internal constant TOKEN_WEI_PER_ETH = 2500e18;
  uint128 internal constant PROFIT = 0.05 ether;
  address internal constant FARMER = address(0xFA12);

  event ConfigSet(uint128 targetRelayerProfit, uint128 maxSubsidyPerOperation, uint128 minMigratedAmount);
  event Defunded(IERC20OZ indexed token, address indexed to, uint256 amount);

  function test_GivenZeroOwner_WhenConstructed_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    _newSubsidy(address(0), address(migrationExecutor), ethUsdFeed);
  }

  function test_GivenFeedWithoutCode_WhenConstructed_ThenReverts() external {
    vm.expectRevert(Errors.MigrationSubsidy__FeedWithoutCode.selector);
    _newSubsidy(OWNER, address(migrationExecutor), AggregatorV3Interface(address(0xFEED)));
  }

  function test_GivenAFeedWithoutEightDecimals_WhenConstructed_ThenReverts() external {
    AggregatorV3Interface feed18 = AggregatorV3Interface(address(new MockV3Aggregator(18, 2500e18)));
    vm.expectRevert(abi.encodeWithSelector(Errors.MigrationSubsidy__UnexpectedFeedDecimals.selector, 18));
    _newSubsidy(OWNER, address(migrationExecutor), feed18);
  }

  function test_GivenZeroExecutor_WhenConstructed_ThenReverts() external {
    vm.expectRevert(Errors.MigrationSubsidy__ZeroExecutor.selector);
    _newSubsidy(OWNER, address(0), ethUsdFeed);
  }

  function test_GivenNonOwner_WhenSetConfig_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    migrationSubsidy.setConfig(1, 2, 3);
  }

  function test_GivenOwner_WhenSetConfig_ThenItRoundTripsAndEmits() external {
    vm.expectEmit(address(migrationSubsidy));
    emit ConfigSet(1, 2, 3);
    vm.prank(OWNER);
    migrationSubsidy.setConfig(1, 2, 3);

    (uint128 profit, uint128 maxSubsidy, uint128 floor) = migrationSubsidy.$config();
    assertEq(profit, 1);
    assertEq(maxSubsidy, 2);
    assertEq(floor, 3);
  }

  function test_GivenAFlow_ThenTheCeilingIsTheConstantForThatFlow() external view {
    assertEq(migrationSubsidy.migrationGasCeiling(IExecutor.Flow.Withdrawal), migrationSubsidy.WITHDRAWAL_GAS_CEILING());
    assertEq(
      migrationSubsidy.migrationGasCeiling(IExecutor.Flow.FrozenNotesRefund),
      migrationSubsidy.FROZEN_NOTES_REFUND_GAS_CEILING()
    );
    assertEq(
      migrationSubsidy.migrationGasCeiling(IExecutor.Flow.FrozenDepositsRefund),
      migrationSubsidy.FROZEN_DEPOSITS_REFUND_GAS_CEILING()
    );
    assertEq(
      migrationSubsidy.migrationGasCeiling(IExecutor.Flow.UnprocessedDepositRefund),
      migrationSubsidy.UNPROCESSED_DEPOSIT_REFUND_GAS_CEILING()
    );
  }

  function test_GivenACallerOtherThanTheExecutor_WhenRecordMigration_ThenReverts() external {
    vm.expectRevert(Errors.MigrationSubsidy__UnauthorizedExecutor.selector);
    migrationSubsidy.recordMigration(IExecutor.Flow.Withdrawal, 1 ether);
  }

  function test_GivenARecordOutsideARelay_ThenALaterRelayIsNotPaid() external givenTeeIsRegistered("tee") {
    vm.prank(address(migrationExecutor));
    migrationSubsidy.recordMigration(IExecutor.Flow.Withdrawal, MIGRATION_AMOUNT);
    freezeSourceForWithdrawals = false;
    bytes memory inner = _migrationWithdrawCall(
      MIGRATION_COMMITMENT, MIGRATION_TIP, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH
    );
    uint256 potBefore = _pot();

    vm.prank(FARMER, FARMER);
    operationExecutor.execute(address(migrationSubsidy), inner, payoutToken, 0, 0, 0);

    assertEq(_pot(), potBefore, "a record outside the relay must not pay a later relay");
  }

  function test_GivenAValue_WhenTheSubsidyIsCalled_ThenItReverts() external {
    vm.deal(address(operationExecutor), 1 ether);
    vm.prank(address(operationExecutor));
    (bool ok,) = address(migrationSubsidy).call{value: 1}(abi.encodeCall(IOxidePortal.freeze, ()));
    assertFalse(ok, "the subsidy must reject ether");
  }

  function test_GivenAFailingForwardedCall_ThenTheRelayRevertsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    _freezeForRefunds();
    frozenNotesRefundVerifier.setAcceptAll(false);
    bytes memory inner = _frozenNotesMigrationCall(
      1, MIGRATION_COMMITMENT, MIGRATION_AMOUNT, MIGRATION_TIP, address(operationExecutor), 1
    );
    uint256 potBefore = _pot();

    vm.expectRevert(CoreErrors.OxidePortal__InvalidFrozenNotesRefundProof.selector);
    vm.prank(FARMER, FARMER);
    operationExecutor.execute(address(migrationSubsidy), inner, payoutToken, 0, 0, 0);

    assertEq(_pot(), potBefore, "a failing relay must not pay");
  }

  function test_GivenAForwardedDeposit_ThenItCannotPullTheSubsidyTokens() external {
    uint256 potBefore = _pot();

    vm.expectRevert(
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(portal), 0, 1 ether)
    );
    vm.prank(FARMER, FARMER);
    operationExecutor.execute(
      address(migrationSubsidy),
      abi.encodeCall(IOxidePortal.deposit, (MIGRATION_COMMITMENT, 1 ether)),
      payoutToken,
      0,
      0,
      0
    );

    assertEq(_pot(), potBefore, "a forwarded deposit must not move the pot");
  }

  function test_GivenNonOwner_WhenDefund_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    migrationSubsidy.defund(IERC20OZ(address(payoutToken)));
  }

  function test_GivenOwner_WhenDefund_ThenTheWholeBalanceGoesToTheOwner() external {
    uint256 ownerBefore = payoutToken.balanceOf(OWNER);

    vm.expectEmit(address(migrationSubsidy));
    emit Defunded(IERC20OZ(address(payoutToken)), OWNER, SUBSIDY_POT);
    vm.prank(OWNER);
    migrationSubsidy.defund(IERC20OZ(address(payoutToken)));

    assertEq(_pot(), 0, "the pot is empty");
    assertEq(payoutToken.balanceOf(OWNER), ownerBefore + SUBSIDY_POT, "the pot goes to the owner");
  }

  function test_GivenOwner_WhenDefundAnotherToken_ThenItsWholeBalanceGoesToTheOwner() external {
    TestERC20 stray = new TestERC20("Stray", "STR", address(this));
    stray.mint(address(migrationSubsidy), 7 ether);

    vm.prank(OWNER);
    migrationSubsidy.defund(IERC20OZ(address(stray)));

    assertEq(stray.balanceOf(address(migrationSubsidy)), 0, "the subsidy keeps none of the stray token");
    assertEq(stray.balanceOf(OWNER), 7 ether, "the stray token goes to the owner");
    assertEq(_pot(), SUBSIDY_POT, "the pot is untouched");
  }

  function test_GivenAFeedUpdatedInTheFuture_WhenARelayIsSent_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    _feed().setUpdatedAt(block.timestamp + 1);
    _assertRelayLandsUnpaid();
  }

  function test_GivenANegativeFeedAnswer_WhenARelayIsSent_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    _feed().setAnswer(-1);
    _assertRelayLandsUnpaid();
  }

  function test_GivenAPriorityFeeAboveTheCap_WhenARelayIsPaid_ThenTheGasPriceIsCapped()
    external
    givenTeeIsRegistered("tee")
  {
    uint256 cappedGasPrice = RELAY_GAS_PRICE + OxideConstants.MAX_PRIORITY_FEE_WEI;
    vm.txGasPrice(5 * RELAY_GAS_PRICE);
    bytes memory inner = _migrationWithdrawCall(
      MIGRATION_COMMITMENT, MIGRATION_TIP, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH
    );
    uint256 potBefore = _pot();

    (uint256 txGas,) = _relay(inner);

    uint256 pricedAtTheCap = ((potBefore - _pot()) * 1e18) / (cappedGasPrice * TOKEN_WEI_PER_ETH);
    assertLe(pricedAtTheCap, txGas, "the subsidy prices the gas above the capped price");
    assertGe(pricedAtTheCap + PRICED_MIGRATION_TOLERANCE, txGas, "the subsidy prices the gas below the capped price");
  }

  function test_GivenAProfit_WhenARelayIsPaid_ThenThePaymentIsThePricedGasPlusTheProfit()
    external
    givenTeeIsRegistered("tee")
  {
    _setConfig(PROFIT, type(uint128).max);
    bytes memory inner = _migrationWithdrawCall(
      MIGRATION_COMMITMENT, MIGRATION_TIP, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH
    );
    uint256 potBefore = _pot();

    (, uint256 priced) = _relay(inner);

    uint256 paid = potBefore - _pot();
    assertGt(priced, 0, "the relay is paid for its gas");
    assertEq(paid, _gasCost(priced, RELAY_GAS_PRICE) + PROFIT, "the payment is the priced gas plus the profit");
  }

  function test_GivenAStaleFeed_WhenARelayIsSent_ThenTheMigrationLandsAndThePotIsUntouched()
    external
    givenTeeIsRegistered("tee")
  {
    _makeFeedStale();
    _assertRelayLandsUnpaid();
  }

  function test_GivenAMaximum_WhenARelayIsPaid_ThenThePaymentIsTheMaximum() external givenTeeIsRegistered("tee") {
    _setConfig(PROFIT, 0.001 ether);
    bytes memory inner = _migrationWithdrawCall(
      MIGRATION_COMMITMENT, MIGRATION_TIP, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH
    );
    uint256 potBefore = _pot();

    _relay(inner);

    assertEq(potBefore - _pot(), 0.001 ether, "the payment stops at the maximum");
  }

  function test_GivenALowBalance_WhenARelayIsPaid_ThenThePaymentIsTheBalance() external givenTeeIsRegistered("tee") {
    _setConfig(PROFIT, type(uint128).max);
    vm.prank(OWNER);
    migrationSubsidy.defund(IERC20OZ(address(payoutToken)));
    _mintPayout(address(migrationSubsidy), 0.001 ether);
    bytes memory inner = _migrationWithdrawCall(
      MIGRATION_COMMITMENT, MIGRATION_TIP, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH
    );

    vm.prank(FARMER, FARMER);
    operationExecutor.execute(address(migrationSubsidy), inner, payoutToken, 0, 0, 0);

    assertEq(_pot(), 0, "the payment empties the pot");
    assertEq(underlying.balanceOf(FARMER), MIGRATION_TIP + 0.001 ether, "the relayer gets the tip and the balance");
  }

  function _assertRelayLandsUnpaid() internal {
    _setConfig(PROFIT, type(uint128).max);
    bytes memory inner = _migrationWithdrawCall(
      MIGRATION_COMMITMENT, MIGRATION_TIP, address(operationExecutor), MIGRATION_WITHDRAWAL_PATH_DEPTH
    );
    uint256 potBefore = _pot();
    uint256 destinationBefore = _destinationBalance();

    _relay(inner);

    assertEq(_pot(), potBefore, "a feed that is not valid pays nothing");
    assertGt(_destinationBalance(), destinationBefore, "the migration must still land");
  }

  function _setConfig(uint128 _profit, uint128 _maxSubsidy) internal {
    vm.prank(OWNER);
    migrationSubsidy.setConfig(_profit, _maxSubsidy, MIN_MIGRATED_AMOUNT);
  }

  function _gasCost(uint256 _gas, uint256 _gasPrice) internal pure returns (uint256) {
    return (_gas * _gasPrice * TOKEN_WEI_PER_ETH) / 1e18;
  }

  function _makeFeedStale() internal {
    uint256 updatedAt = vm.getBlockTimestamp();
    vm.warp(updatedAt + EthUsdMinOutLib.MAX_PRICE_AGE + 1);
    _feed().setUpdatedAt(updatedAt);
  }

  function _feed() internal view returns (MockV3Aggregator) {
    return MockV3Aggregator(address(ethUsdFeed));
  }

  function _newSubsidy(address _owner, address _executor, AggregatorV3Interface _feedAddress)
    internal
    returns (MigrationSubsidy)
  {
    return new MigrationSubsidy(
      _owner,
      IERC20OZ(address(payoutToken)),
      address(portal),
      address(destinationPortal),
      _executor,
      keccak256(type(OperationExecutor).runtimeCode),
      _feedAddress
    );
  }
}
