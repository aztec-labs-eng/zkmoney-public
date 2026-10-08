// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Ownable} from "@oz/access/Ownable.sol";

import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {WithdrawalSubsidy} from "@periphery/WithdrawalSubsidy.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {Errors} from "@periphery/Errors.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";

contract WithdrawalSubsidyTest is OxidePortalBase {
  WithdrawalSubsidy internal fm;
  MockV3Aggregator internal priceFeed;

  uint256 internal constant START_WEI = 2 gwei;
  uint256 internal constant GAS_PRICE_WEI = 10 gwei;
  uint256 internal constant EXCESS_WEI = GAS_PRICE_WEI - START_WEI;

  uint256 internal constant TOKEN_WEI_PER_ETH = 3000e18;

  uint256 internal constant UNBOUND_CAP = 1000 ether;

  IExecutor.Flow internal constant WITHDRAWAL = IExecutor.Flow.Withdrawal;
  IExecutor.Flow internal constant NOTES_REFUND = IExecutor.Flow.FrozenNotesRefund;

  address internal constant EXECUTOR = address(0xE5EC);
  address internal constant OTHER_EXECUTOR = address(0xBAD);
  address internal constant TIP_RECIPIENT = address(0x71B);

  function setUp() public virtual override {
    super.setUp();
    priceFeed = new MockV3Aggregator(8, 3000e8);
    fm = new WithdrawalSubsidy(OWNER, address(portal), EXECUTOR, AggregatorV3Interface(address(priceFeed)));
    underlying.mint(address(fm), 1_000_000 ether);
  }

  function test_GivenConstructed_ThenImmutablesAreWired() external view {
    assertEq(fm.EXECUTOR(), EXECUTOR);
    assertEq(address(fm.TOKEN()), address(underlying));
    assertEq(fm.TOKEN_DECIMALS(), 18);
    assertEq(address(fm.PRICE_FEED()), address(priceFeed));
    assertEq(fm.owner(), OWNER);
  }

  function test_GivenZeroOwner_WhenConstructed_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    new WithdrawalSubsidy(address(0), address(portal), EXECUTOR, AggregatorV3Interface(address(priceFeed)));
  }

  function test_GivenFeedWithoutCode_WhenConstructed_ThenReverts() external {
    vm.expectRevert(Errors.WithdrawalSubsidy__FeedWithoutCode.selector);
    new WithdrawalSubsidy(OWNER, address(portal), EXECUTOR, AggregatorV3Interface(address(0xFEED)));
  }

  function test_GivenZeroExecutor_WhenConstructed_ThenReverts() external {
    vm.expectRevert(Errors.WithdrawalSubsidy__ZeroExecutor.selector);
    new WithdrawalSubsidy(OWNER, address(portal), address(0), AggregatorV3Interface(address(priceFeed)));
  }

  function test_GivenNonOwner_WhenSetFlowPricing_ThenReverts() external {
    WithdrawalSubsidy.FlowPricing memory p;
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    fm.setFlowPricing(WITHDRAWAL, p);
  }

  function test_GivenOwner_WhenSetFlowPricing_ThenRoundTrips() external {
    _setFlowPricing(WITHDRAWAL, 2 gwei, 60 ether);

    (uint256 startPriceWei, uint256 maxSubsidy) = fm.$flowPricing(WITHDRAWAL);
    assertEq(startPriceWei, 2 gwei);
    assertEq(maxSubsidy, 60 ether);
  }

  function test_GivenAFlow_ThenModeledTxGasIsTheHardcodedConstantForThatFlow() external view {
    assertEq(fm.modeledTxGas(IExecutor.Flow.Withdrawal), fm.WITHDRAWAL_TX_GAS());
    assertEq(fm.modeledTxGas(IExecutor.Flow.FrozenNotesRefund), fm.FROZEN_NOTES_REFUND_TX_GAS());
    assertEq(fm.modeledTxGas(IExecutor.Flow.FrozenDepositRefund), fm.FROZEN_DEPOSIT_REFUND_TX_GAS());
    assertEq(fm.modeledTxGas(IExecutor.Flow.UnprocessedDepositRefund), fm.UNPROCESSED_DEPOSIT_REFUND_TX_GAS());
  }

  function test_GivenOneFlowPriced_ThenTheOtherFlowsStayUnpriced() external {
    _setFlowPricing(WITHDRAWAL, START_WEI, UNBOUND_CAP);
    _setGasPrice(GAS_PRICE_WEI);

    assertGt(fm.quoteSubsidy(WITHDRAWAL), 0);
    assertEq(fm.quoteSubsidy(NOTES_REFUND), 0);
  }

  function test_GivenTwoPricedFlows_ThenEachQuotesItsOwnModel() external {
    _setFlowPricing(WITHDRAWAL, START_WEI, UNBOUND_CAP);
    _setFlowPricing(NOTES_REFUND, START_WEI, UNBOUND_CAP);
    _setGasPrice(GAS_PRICE_WEI);

    assertEq(fm.quoteSubsidy(WITHDRAWAL), _priced(_flowGas(WITHDRAWAL)));
    assertEq(fm.quoteSubsidy(NOTES_REFUND), _priced(_flowGas(NOTES_REFUND)));
    assertGt(fm.quoteSubsidy(NOTES_REFUND), fm.quoteSubsidy(WITHDRAWAL));
  }

  function test_GivenNonOwner_WhenDefund_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    fm.defund();
  }

  function test_GivenOwner_WhenDefund_ThenSweepsFullBalanceToOwner() external {
    uint256 reserve = underlying.balanceOf(address(fm));
    assertGt(reserve, 0, "the withdrawal subsidy should start funded");
    uint256 ownerBefore = underlying.balanceOf(OWNER);

    vm.prank(OWNER);
    fm.defund();

    assertEq(underlying.balanceOf(address(fm)), 0, "reserve drained");
    assertEq(underlying.balanceOf(OWNER), ownerBefore + reserve, "reserve moved to owner");
  }

  function test_GivenEmptyReserve_WhenDefund_ThenNoop() external {
    vm.prank(OWNER);
    fm.defund();
    uint256 ownerBefore = underlying.balanceOf(OWNER);

    vm.prank(OWNER);
    fm.defund();

    assertEq(underlying.balanceOf(address(fm)), 0);
    assertEq(underlying.balanceOf(OWNER), ownerBefore);
  }

  function test_GivenZeroPricing_ThenQuoteIsZero() external {
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenAPricedFlow_ThenTheQuotePricesTheWholeModeledTx() external {
    _setPricing(START_WEI);
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), _priced(_flowGas(WITHDRAWAL)));
  }

  function test_GivenGasPriceBelowKickIn_ThenZero() external {
    _setPricing(START_WEI);
    _setGasPrice(START_WEI - 1);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenGasPriceAtKickIn_ThenZero() external {
    _setPricing(START_WEI);
    _setGasPrice(START_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenGasPriceAboveKickIn_ThenPricesOnlyTheExcess() external {
    _setPricing(START_WEI);
    uint256 totalGas = _flowGas(WITHDRAWAL);

    _setGasPrice(START_WEI + 1 gwei);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), totalGas * 1 gwei * TOKEN_WEI_PER_ETH / 1e18);

    _setGasPrice(START_WEI + 2 gwei);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), totalGas * 2 gwei * TOKEN_WEI_PER_ETH / 1e18);
  }

  function test_GivenGasCostAboveTheCap_ThenClampedAtTheCap() external {
    uint256 cap = 1 ether;
    _setPricingFull(START_WEI, cap);
    _setGasPrice(50 gwei);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), cap);
  }

  function test_GivenGasCostBelowTheCap_ThenPricedAtTheExcess() external {
    _setPricing(START_WEI);
    _setGasPrice(START_WEI + 3 gwei);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), _flowGas(WITHDRAWAL) * 3 gwei * TOKEN_WEI_PER_ETH / 1e18);
  }

  function test_GivenEthPriceDoubles_ThenAnUncappedQuoteDoubles() external {
    _setPricing(START_WEI);
    _setGasPrice(GAS_PRICE_WEI);
    uint256 atThreeThousand = fm.quoteSubsidy(WITHDRAWAL);

    priceFeed.setAnswer(6000e8);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 2 * atThreeThousand);
  }

  function test_GivenEthPriceDoubles_ThenACappedQuoteDoesNotMove() external {
    uint256 cap = 1 ether;
    _setPricingFull(START_WEI, cap);
    _setGasPrice(50 gwei);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), cap);

    priceFeed.setAnswer(6000e8);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), cap);
  }

  function test_GivenZeroCap_ThenZero() external {
    _setPricingFull(START_WEI, 0);
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenInsufficientBudget_ThenZero() external {
    _setPricing(START_WEI);
    _setGasPrice(GAS_PRICE_WEI);
    deal(address(underlying), address(fm), 0);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenTipUnderThePriorityCap_ThenPricedAtTxGasPrice() external {
    _setPricing(START_WEI);
    uint256 tip = OxideConstants.MAX_PRIORITY_FEE_WEI / 2;
    vm.fee(START_WEI + 1 gwei);
    vm.txGasPrice(START_WEI + 1 gwei + tip);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), _flowGas(WITHDRAWAL) * (1 gwei + tip) * TOKEN_WEI_PER_ETH / 1e18);
  }

  function test_GivenTipAboveMaxPriorityFee_ThenPricedAtBasefeePlusMaxPriorityFee() external {
    _setPricing(START_WEI);
    vm.fee(START_WEI + 1 gwei);
    vm.txGasPrice(START_WEI + 1 gwei + 5 gwei);
    assertEq(
      fm.quoteSubsidy(WITHDRAWAL),
      _flowGas(WITHDRAWAL) * (1 gwei + OxideConstants.MAX_PRIORITY_FEE_WEI) * TOKEN_WEI_PER_ETH / 1e18
    );
  }

  function test_GivenZeroFeedPrice_ThenZero() external {
    MockV3Aggregator zeroFeed = new MockV3Aggregator(8, 0);
    WithdrawalSubsidy zfm =
      new WithdrawalSubsidy(OWNER, address(portal), EXECUTOR, AggregatorV3Interface(address(zeroFeed)));
    underlying.mint(address(zfm), 1_000_000 ether);
    vm.prank(OWNER);
    zfm.setFlowPricing(WITHDRAWAL, WithdrawalSubsidy.FlowPricing({startPriceWei: START_WEI, maxSubsidy: UNBOUND_CAP}));
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(zfm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenNegativeFeedPrice_WhenQuoted_ThenZero() external {
    _setPricing(START_WEI);
    priceFeed.setAnswer(-1);
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenStaleFeed_WhenQuoted_ThenZero() external {
    _setPricing(START_WEI);
    vm.warp(10 hours);
    priceFeed.setUpdatedAt(block.timestamp - (1 hours + 1));
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenAFeedDatedAhead_WhenQuoted_ThenZero() external {
    _setPricing(START_WEI);
    vm.warp(10 hours);
    priceFeed.setUpdatedAt(block.timestamp + 1);
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenFeedExactlyAtMaxAge_WhenQuoted_ThenPricedAtFeedRate() external {
    _setPricing(START_WEI);
    vm.warp(10 hours);
    priceFeed.setUpdatedAt(block.timestamp - 1 hours);
    _setGasPrice(GAS_PRICE_WEI);
    assertEq(fm.quoteSubsidy(WITHDRAWAL), _priced(_flowGas(WITHDRAWAL)));
  }

  function test_GivenFeedDecimalsPastThePowerOfTen_WhenQuoted_ThenZero() external {
    MockV3Aggregator wideFeed = new MockV3Aggregator(78, 3000e8);
    WithdrawalSubsidy wfm =
      new WithdrawalSubsidy(OWNER, address(portal), EXECUTOR, AggregatorV3Interface(address(wideFeed)));
    underlying.mint(address(wfm), 1_000_000 ether);
    vm.prank(OWNER);
    wfm.setFlowPricing(WITHDRAWAL, WithdrawalSubsidy.FlowPricing({startPriceWei: START_WEI, maxSubsidy: UNBOUND_CAP}));
    _setGasPrice(GAS_PRICE_WEI);

    assertEq(wfm.quoteSubsidy(WITHDRAWAL), 0);
  }

  function test_GivenAnotherCaller_WhenPaySubsidy_ThenReverts() external {
    _setPricing(START_WEI);
    _setGasPrice(GAS_PRICE_WEI);
    vm.prank(OTHER_EXECUTOR);
    vm.expectRevert(Errors.WithdrawalSubsidy__UnauthorizedExecutor.selector);
    fm.paySubsidy(WITHDRAWAL, TIP_RECIPIENT);
  }

  function test_GivenZeroTipRecipient_WhenPaySubsidy_ThenReverts() external {
    _setPricing(START_WEI);
    vm.prank(EXECUTOR);
    vm.expectRevert(Errors.WithdrawalSubsidy__ZeroTipRecipient.selector);
    fm.paySubsidy(WITHDRAWAL, address(0));
  }

  function test_GivenTheExecutor_WhenPaySubsidy_ThenTransfersTheQuote() external {
    _setPricing(START_WEI);
    _setGasPrice(GAS_PRICE_WEI);
    uint256 expected = fm.quoteSubsidy(WITHDRAWAL);
    assertGt(expected, 0);

    vm.prank(EXECUTOR);
    uint256 paid = fm.paySubsidy(WITHDRAWAL, TIP_RECIPIENT);

    assertEq(paid, expected);
    assertEq(underlying.balanceOf(TIP_RECIPIENT), expected);
  }

  function test_GivenUnpricedFlow_WhenPaySubsidy_ThenPaysNothing() external {
    _setPricing(START_WEI);
    _setGasPrice(GAS_PRICE_WEI);

    vm.prank(EXECUTOR);
    uint256 paid = fm.paySubsidy(NOTES_REFUND, TIP_RECIPIENT);

    assertEq(paid, 0);
    assertEq(underlying.balanceOf(TIP_RECIPIENT), 0);
  }

  function _priced(uint256 _gas) internal pure returns (uint256) {
    return _gas * EXCESS_WEI * TOKEN_WEI_PER_ETH / 1e18;
  }

  function _setPricing(uint256 _startPriceWei) internal {
    _setPricingFull(_startPriceWei, UNBOUND_CAP);
  }

  function _setPricingFull(uint256 _startPriceWei, uint256 _cap) internal {
    _setFlowPricing(WITHDRAWAL, _startPriceWei, _cap);
  }

  function _setFlowPricing(IExecutor.Flow _flow, uint256 _startPriceWei, uint256 _maxSubsidy) internal {
    vm.prank(OWNER);
    fm.setFlowPricing(_flow, WithdrawalSubsidy.FlowPricing({startPriceWei: _startPriceWei, maxSubsidy: _maxSubsidy}));
  }

  function _flowGas(IExecutor.Flow _flow) internal view returns (uint256) {
    return fm.modeledTxGas(_flow);
  }

  function _setGasPrice(uint256 _gasPriceWei) internal {
    vm.fee(_gasPriceWei);
    vm.txGasPrice(_gasPriceWei);
  }
}
