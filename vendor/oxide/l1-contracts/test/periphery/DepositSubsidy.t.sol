// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Ownable} from "@oz/access/Ownable.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@periphery/Errors.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

contract FakePortal {
  address public immutable PORTAL;
  IERC20 public immutable UNDERLYING;
  uint256 public constant ROLLUP_VERSION = 1;

  constructor(IERC20 _underlying) {
    PORTAL = address(this);
    UNDERLYING = _underlying;
  }
}

contract SixDecERC20 is TestERC20 {
  constructor(string memory _name, string memory _symbol, address _owner) TestERC20(_name, _symbol, _owner) {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }
}

contract DepositSubsidyTest is OxidePortalBase {
  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;

  address internal constant RECIPIENT = address(0xBEEF);

  uint128 internal constant FEE = 1e17;
  int256 internal constant ETH_USD = 2500e8;
  uint256 internal constant GAS_LEG_UNIT_FEE = 4e8;
  uint256 internal constant BASEFEE = GAS_LEG_UNIT_FEE;
  uint256 internal constant PRICED_GAS = 200_000;
  uint256 internal constant GAS_LEG = PRICED_GAS * 1e12;

  function setUp() public virtual override {
    super.setUp();
    sm = DepositSubsidy(address(depositSubsidy));
    feed = new MockV3Aggregator(8, ETH_USD);
  }

  function test_GivenConstructed_ThenImmutablesDerivedFromGateway() external view {
    assertEq(sm.PORTAL(), address(portal));
    assertEq(sm.PORTAL(), address(portal));
    assertEq(address(sm.TOKEN()), address(underlying));
    assertEq(address(sm.SIPA_FACTORY()), address(sipaFactory));
    assertEq(sm.ROLLUP_VERSION(), portal.ROLLUP_VERSION());
  }

  function test_GivenConstructed_ThenPriceFeedStored() external {
    DepositSubsidy fresh = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(feed)), sipaFactory);
    assertEq(address(fresh.PRICE_FEED()), address(feed));
  }

  function test_GivenConstructed_ThenOwnerIsConstructorArg() external view {
    assertEq(sm.owner(), OWNER);
    assertTrue(OWNER != address(this));
  }

  function test_GivenZeroOwner_WhenConstructed_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    new DepositSubsidy(address(0), address(portal), AggregatorV3Interface(address(feed)), sipaFactory);
  }

  function test_GivenCodelessFeed_WhenConstructed_ThenReverts() external {
    vm.expectRevert(Errors.DepositSubsidy__FeedWithoutCode.selector);
    new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(makeAddr("eoa-feed")), sipaFactory);

    vm.expectRevert(Errors.DepositSubsidy__FeedWithoutCode.selector);
    new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(0)), sipaFactory);
  }

  function test_GivenOwner_WhenSetDepositConfig_ThenStoresAndAnnounces() external {
    vm.expectEmit(true, true, true, true, address(sm));
    uint128 overheadGas = 30_000;
    emit DepositSubsidy.DepositConfigSet(FEE, 5e18, FEE, 7e18, overheadGas);
    vm.prank(OWNER);
    sm.setDepositConfig(FEE, 5e18, FEE, 7e18, overheadGas);

    (uint128 approximateMinProfit, uint128 max, uint128 minFee, uint128 minCreditedAmount, uint128 storedOverheadGas) =
      sm.$depositConfig();
    assertEq(approximateMinProfit, FEE);
    assertEq(max, 5e18);
    assertEq(minFee, FEE);
    assertEq(minCreditedAmount, 7e18);
    assertEq(storedOverheadGas, overheadGas);
  }

  function test_GivenNonOwner_WhenSetDepositConfig_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    sm.setDepositConfig(FEE, 5e18, FEE, 0, 0);
  }

  function test_GivenProfitAboveTheFeeFloor_WhenSetDepositConfig_ThenReverts() external {
    vm.prank(OWNER);
    vm.expectRevert(abi.encodeWithSelector(Errors.DepositSubsidy__ProfitAboveFeeFloor.selector, FEE + 1, FEE));
    sm.setDepositConfig(FEE + 1, 5e18, FEE, 0, 0);
  }

  function test_GivenNoDepositConfig_WhenDepositSubsidyQueried_ThenZero() external {
    _fund(10e18);
    assertEq(_query(FEE), 0);
  }

  function test_GivenRealisticConfig_WhenDepositSubsidyQueried_ThenExactAmount() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(FEE), GAS_LEG);
  }

  function test_GivenADearerIntent_WhenDepositSubsidyQueried_ThenTheGasLegGrowsWithIt() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(1000e18);

    assertEq(sm.quoteSubsidy(FEE, 600_000), 600_000 * 1e12);
    assertEq(sm.quoteSubsidy(FEE, 700_000), 700_000 * 1e12);
  }

  function test_GivenZeroSweepGas_WhenDepositSubsidyQueried_ThenNoGasLeg() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(100e18);

    assertEq(sm.quoteSubsidy(FEE, 0), 0);
    assertEq(sm.quoteSubsidy(2 * FEE, 0), 0);
  }

  function test_GivenTargetAtOrBelowFee_WhenDepositSubsidyQueried_ThenZero() external {
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(10e18);

    assertEq(_query(FEE), 0);
    assertEq(_query(FEE + 1), 0);
  }

  function test_GivenComputedExceedsMax_WhenDepositSubsidyQueried_ThenCappedAtMax() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, 5e16);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(FEE), 5e16);
  }

  function test_GivenMaxZero_WhenDepositSubsidyQueried_ThenZero() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, 0);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(FEE), 0);
  }

  function test_GivenNonStandardFeedDecimals_WhenDepositSubsidyQueried_ThenScaledByFeedDecimals() external {
    MockV3Aggregator feed18 = new MockV3Aggregator(18, 2500e18);
    _priceGas();
    _newSm(address(feed18));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(FEE), GAS_LEG);
  }

  function test_Given6DecimalToken_WhenDepositSubsidyQueried_ThenScaledByTokenDecimals() external {
    SixDecERC20 token6 = new SixDecERC20("Six", "S6", address(this));
    FakePortal portal6 = new FakePortal(IERC20(address(token6)));
    _priceGas();
    sm = new DepositSubsidy(OWNER, address(portal6), AggregatorV3Interface(address(feed)), sipaFactory);
    vm.prank(OWNER);
    sm.setDepositConfig(1e5, type(uint128).max, 1e5, 0, 0);
    token6.mint(address(sm), PRICED_GAS + 10e6);

    assertEq(sm.quoteSubsidy(1e5, PRICED_GAS), PRICED_GAS);
  }

  function test_GivenAPriorityFee_WhenQueried_ThenNoneOfItIsPriced() external {
    vm.fee(BASEFEE);
    vm.txGasPrice(BASEFEE + 1 gwei);
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(100e18);

    assertEq(_query(FEE), GAS_LEG, "the quote must price the basefee and nothing above it");

    vm.txGasPrice(BASEFEE + 0.05 gwei);
    assertEq(_query(FEE), GAS_LEG, "a modest tip is priced the same as a generous one: not at all");
  }

  function test_GivenAnUnpricedCall_WhenQueried_ThenZero() external {
    vm.fee(BASEFEE);
    vm.txGasPrice(0);
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(100e18);

    assertEq(_query(FEE), 0);
  }

  function test_GivenBudgetExactlyMatches_WhenDepositSubsidyQueried_ThenFullReturned() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG);

    assertEq(_query(FEE), GAS_LEG);
  }

  function test_GivenBudgetOneShort_WhenDepositSubsidyQueried_ThenBalanceReturned() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG - 1);

    assertEq(_query(FEE), GAS_LEG - 1);
  }

  function test_GivenFeeBelowMinProfit_WhenDepositSubsidyQueried_ThenZero() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(FEE - 1), 0);
    assertEq(_query(0), 0);
  }

  function test_GivenFeeAtMinProfit_WhenDepositSubsidyQueried_ThenQuoted() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(FEE), GAS_LEG);
  }

  function test_GivenZeroMinFee_ThenAZeroFeeDepositIsQuotedItsGasAlone() external {
    _priceGas();
    _newSm(address(feed));
    vm.prank(OWNER);
    sm.setDepositConfig(0, type(uint128).max, 0, 0, 0);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(0), GAS_LEG);
  }

  function test_GivenNegativeFeedPrice_WhenDepositSubsidyQueried_ThenReturnsZero() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    feed.setAnswer(-1);
    assertEq(_query(FEE), 0);
  }

  function test_GivenStaleFeed_WhenDepositSubsidyQueried_ThenReturnsZero() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    vm.warp(10 hours);
    feed.setUpdatedAt(block.timestamp - (1 hours + 1));
    assertEq(_query(FEE), 0);
  }

  function test_GivenFeedExactlyAtMaxAge_WhenDepositSubsidyQueried_ThenAccepted() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    vm.warp(10 hours);
    feed.setUpdatedAt(block.timestamp - 1 hours);
    assertEq(_query(FEE), GAS_LEG);
  }

  function test_GivenZeroFeedPrice_WhenDepositSubsidyQueried_ThenGasLegIsZero() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(10e18);

    feed.setAnswer(0);
    assertEq(_query(FEE), 0);
  }

  function test_GivenAFeedDatedAhead_WhenDepositSubsidyQueried_ThenReturnsZero() external {
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    vm.warp(10 hours);
    feed.setUpdatedAt(block.timestamp + 1);
    assertEq(_query(FEE), 0);
  }

  function test_GivenAnAnswerThatWouldOverflowTheProduct_WhenDepositSubsidyQueried_ThenCappedNotReverted() external {
    uint128 cap = 1e18;
    _priceGas();
    _newSm(address(feed));
    _setDeposit(FEE, cap);
    _fund(GAS_LEG + 10e18);

    feed.setAnswer(1e50);
    assertEq(_query(FEE), cap);
  }

  function test_GivenFeedDecimalsPastThePowerOfTen_WhenDepositSubsidyQueried_ThenReturnsZero() external {
    MockV3Aggregator wideFeed = new MockV3Aggregator(78, ETH_USD);
    _priceGas();
    _newSm(address(wideFeed));
    _setDeposit(FEE, type(uint128).max);
    _fund(GAS_LEG + 10e18);

    assertEq(_query(FEE), 0);
  }

  function test_GivenOwner_WhenDefundCalled_ThenTransfersFullBalanceToOwner() external {
    _fund(1000);

    vm.prank(OWNER);
    sm.defund();

    assertEq(underlying.balanceOf(OWNER), 1000);
    assertEq(underlying.balanceOf(address(sm)), 0);
  }

  function test_GivenNonOwner_WhenDefundCalled_ThenReverts() external {
    _fund(1000);

    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    sm.defund();
  }

  function _fund(uint256 _amount) internal {
    underlying.mint(address(sm), _amount);
  }

  function _newSm(address _feed) internal {
    sm = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(_feed), sipaFactory);
  }

  function _setDeposit(uint128 _approximateMinProfit, uint128 _max) internal {
    vm.prank(OWNER);
    sm.setDepositConfig(_approximateMinProfit, _max, _approximateMinProfit, 0, 0);
  }

  function _priceGas() internal {
    vm.fee(BASEFEE);
    vm.txGasPrice(BASEFEE);
  }

  function _query(uint256 _fee) internal view returns (uint256) {
    return sm.quoteSubsidy(_fee, PRICED_GAS);
  }
}
