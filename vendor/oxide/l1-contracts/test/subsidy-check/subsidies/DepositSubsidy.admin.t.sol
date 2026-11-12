// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Intents} from "@periphery/Intent.sol";
import {
  SweepGasCeilings,
  SWEEP_GAS_DEPOSIT_CEILING,
  SWEEP_GAS_REGISTRATION_CEILING,
  SWEEP_GAS_ADD_PASSKEY_CEILING
} from "@test/helpers/SweepGasCeilings.sol";
import {Ownable} from "@oz/access/Ownable.sol";

import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@periphery/Errors.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

contract DepositSubsidyAdminTest is OxidePortalBase {
  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;

  uint128 internal constant FEE = 1e17;
  int256 internal constant ETH_USD = 2500e8;

  function setUp() public virtual override {
    super.setUp();
    sm = DepositSubsidy(address(depositSubsidy));
    feed = new MockV3Aggregator(8, ETH_USD);
  }

  function test_GivenConstructed_ThenImmutablesDerivedFromGateway() external view {
    assertEq(sm.PORTAL(), address(portal));
    assertEq(address(sm.EXECUTOR()), address(operationExecutor));
    assertEq(address(sm.TOKEN()), address(underlying));
    assertEq(address(sm.SIPA_FACTORY()), address(sipaFactory));
    assertEq(sm.ROLLUP_VERSION(), portal.ROLLUP_VERSION());
  }

  function test_GivenConstructed_ThenPriceFeedStored() external {
    assertEq(address(_newSm(address(feed)).PRICE_FEED()), address(feed));
  }

  function test_GivenConstructed_ThenOwnerIsConstructorArg() external view {
    assertEq(sm.owner(), OWNER);
    assertTrue(OWNER != address(this));
  }

  function test_GivenZeroOwner_WhenConstructed_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    new DepositSubsidy(
      address(0),
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      sipaFactory,
      SweepGasCeilings.initial()
    );
  }

  function test_GivenCodelessFeed_WhenConstructed_ThenReverts() external {
    vm.expectRevert(Errors.DepositSubsidy__FeedWithoutCode.selector);
    _newSm(makeAddr("eoa-feed"));

    vm.expectRevert(Errors.DepositSubsidy__FeedWithoutCode.selector);
    _newSm(address(0));
  }

  function test_GivenFeedWithout8Decimals_WhenConstructed_ThenReverts() external {
    MockV3Aggregator feed18 = new MockV3Aggregator(18, 2500e18);
    vm.expectRevert(abi.encodeWithSelector(Errors.DepositSubsidy__UnexpectedFeedDecimals.selector, 18));
    _newSm(address(feed18));
  }

  function test_GivenInitialCeilings_WhenConstructed_ThenEachIntentHasItsCeiling() external view {
    assertEq(sm.$sweepGasCeilings(Intents.DEPOSIT), SWEEP_GAS_DEPOSIT_CEILING);
    assertEq(sm.$sweepGasCeilings(Intents.REGISTRATION), SWEEP_GAS_REGISTRATION_CEILING);
    assertEq(sm.$sweepGasCeilings(Intents.ADD_PASSKEY), SWEEP_GAS_ADD_PASSKEY_CEILING);
  }

  function test_GivenOwner_WhenSetDepositConfig_ThenStoresAndAnnounces() external {
    vm.expectEmit(true, true, true, true, address(sm));
    emit DepositSubsidy.DepositConfigSet(FEE, 5e18, 7e18);
    vm.prank(OWNER);
    sm.setDepositConfig(FEE, 5e18, 7e18);

    (uint128 targetRelayerProfit, uint128 maxSubsidyPerOperation, uint128 minCreditedAmount) = sm.$depositConfig();
    assertEq(targetRelayerProfit, FEE);
    assertEq(maxSubsidyPerOperation, 5e18);
    assertEq(minCreditedAmount, 7e18);
  }

  function test_GivenNonOwner_WhenSetDepositConfig_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    sm.setDepositConfig(FEE, 5e18, 0);
  }

  function test_GivenOwner_WhenSetSweepGasCeiling_ThenStoresAndEmits() external {
    vm.expectEmit(true, true, true, true, address(sm));
    emit DepositSubsidy.SweepGasCeilingSet(Intents.ADD_PASSKEY, 900_000);
    vm.prank(OWNER);
    sm.setSweepGasCeiling(Intents.ADD_PASSKEY, 900_000);

    assertEq(sm.$sweepGasCeilings(Intents.ADD_PASSKEY), 900_000);
  }

  function test_GivenNonOwner_WhenSetSweepGasCeiling_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    sm.setSweepGasCeiling(Intents.ADD_PASSKEY, 900_000);
  }

  function test_GivenOwner_WhenDefundCalled_ThenTransfersFullBalanceToOwner() external {
    underlying.mint(address(sm), 1000);

    vm.prank(OWNER);
    sm.defund();

    assertEq(underlying.balanceOf(OWNER), 1000);
    assertEq(underlying.balanceOf(address(sm)), 0);
  }

  function test_GivenNonOwner_WhenDefundCalled_ThenReverts() external {
    underlying.mint(address(sm), 1000);

    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    sm.defund();
  }

  function _newSm(address _feed) internal returns (DepositSubsidy) {
    return new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(_feed),
      sipaFactory,
      SweepGasCeilings.initial()
    );
  }
}
