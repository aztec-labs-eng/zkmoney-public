// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {DepositSubsidyHarness, PotToken, PortalStub} from "@test/subsidy-check/subsidies/SubsidyHarnesses.sol";
import {DepositSubsidySetup, SubsidyMath} from "@test/subsidy-check/subsidies/SubsidySetup.sol";

contract DepositSubsidyQuoteTest is DepositSubsidySetup {
  uint256 internal constant WAD = 1e18;
  uint256 internal constant GWEI = 1e9;
  uint256 internal constant MAX_COVER = 2 ** 24;
  uint256 internal constant MAX_TOKEN_PER_ETH = 2 ** 96;
  uint256 internal constant SLACK = 2 ** 126;
  uint256 internal constant ETH_2000 = 2000e18;
  uint256 internal constant ETH_2324 = 2324.26e18;
  uint256 internal constant MAX_PRICE_AGE = EthUsdMinOutLib.MAX_PRICE_AGE;

  struct Envelope {
    uint256 cover;
    uint256 priced;
    uint256 baseFee;
    uint256 gasPrice;
    uint256 tokenPerEth;
    uint256 fee;
    uint256 profit;
    uint256 cap;
    uint256 pot;
  }

  function _quote(uint256 _fee, uint256 _gas, uint256 _tokenPerEth) internal view returns (uint256) {
    return subsidy.exposedQuote(_fee, _gas, _tokenPerEth);
  }

  function _apply(Envelope memory _e) internal {
    _configure(uint128(_e.profit), uint128(_e.cap));
    _fundPot(_e.pot);
    _setPrices(_e.baseFee, _e.gasPrice);
  }

  function _flat(uint128 _profit, uint128 _cap, uint256 _pot) internal {
    _configure(_profit, _cap);
    _fundPot(_pot);
    _setPrices(GWEI, GWEI);
  }

  function testFuzz_GivenAnyInput_ThenTheSubsidyIsAtMostThePricedGasCostTheCapAndThePot(
    uint256 _fee,
    uint256 _gas,
    uint256 _tokenPerEth,
    uint128 _profit,
    uint128 _cap,
    uint256 _pot,
    uint256 _baseFee,
    uint256 _txGasPrice
  ) external {
    uint256 fee = bound(_fee, 0, type(uint128).max);
    uint256 gas = bound(_gas, 0, 2 ** 32);
    uint256 tokenPerEth = bound(_tokenPerEth, 0, type(uint128).max);
    uint256 pot = bound(_pot, 0, type(uint128).max);
    uint256 baseFee = bound(_baseFee, 0, type(uint64).max);
    uint256 txGasPrice = bound(_txGasPrice, 0, type(uint64).max);
    _configure(_profit, _cap);
    _fundPot(pot);
    _setPrices(baseFee, txGasPrice);

    uint256 paid = _quote(fee, gas, tokenPerEth);

    uint256 price = SubsidyMath.pricedGasPrice(baseFee, txGasPrice);
    assertLe(paid * WAD, gas * price * tokenPerEth, "the subsidy pays more than the priced gas costs: a farmer gains");
    assertLe(paid, _cap, "the subsidy pays more than the cap");
    assertLe(paid, pot, "the subsidy pays more than the pot holds");
  }

  function test_GivenARelayerTransaction_ThenTheNoFarmingBoundIsReachedWithAPositivePayment() external {
    _configure(0, type(uint128).max);
    _setPrices(GWEI, GWEI);
    uint256 paid = _quote(0, 1000, ETH_2000);
    assertGt(paid, 0, "the witness pays nothing");
    assertEq(paid * WAD, 1000 * GWEI * ETH_2000, "a zero-fee quote pays exactly the priced gas cost");
  }

  function testFuzz_GivenTheEnvelope_ThenTheFeeAndTheSubsidyPayTheRequiredPayout(
    uint256 _cover,
    uint256 _priced,
    uint256 _baseFee,
    uint256 _tip,
    uint256 _tokenPerEth,
    uint256[4] memory _slack
  ) external {
    Envelope memory e = _envelope(_cover, _priced, _baseFee, _tip, _tokenPerEth, _slack, WAD);
    _apply(e);

    uint256 paid = _quote(e.fee, e.priced, e.tokenPerEth);

    assertGe(
      e.fee + paid,
      SubsidyMath.required(e.cover, e.gasPrice, e.tokenPerEth),
      "inside the envelope the relayer is short of the payout that the executor requires"
    );
  }

  function testFuzz_GivenNoMargin_ThenThePayoutIsShortByAtMostOneTokenWei(
    uint256 _cover,
    uint256 _priced,
    uint256 _baseFee,
    uint256 _tip,
    uint256 _tokenPerEth,
    uint256[4] memory _slack
  ) external {
    Envelope memory e = _envelope(_cover, _priced, _baseFee, _tip, _tokenPerEth, _slack, 0);
    _apply(e);

    uint256 paid = _quote(e.fee, e.priced, e.tokenPerEth);

    assertGe(
      e.fee + paid + 1,
      SubsidyMath.required(e.cover, e.gasPrice, e.tokenPerEth),
      "without the margin the relayer is short by more than 1 token-wei"
    );
  }

  function test_GivenTheSmallestProfitWithoutTheMargin_ThenThePayoutIsShortByOneTokenWei() external {
    _configure(1, type(uint128).max);
    _setPrices(1, 1);
    uint256 paid = _quote(1, 1, 0.5e18);
    assertEq(paid, 0, "the gas cost rounds to 0 and the fee covers the target");
    assertEq(1 + paid + 1, SubsidyMath.required(3, 1, 0.5e18), "the counterexample without the margin moved");
  }

  function testFuzz_GivenTheSmallestProfitThatPays_ThenThePayoutLandsExactlyOnTheRequiredPayout(
    uint256 _cover,
    uint256 _priced,
    uint256 _baseFee,
    uint256 _tip,
    uint256 _tokenPerEth
  ) external {
    uint256 cover = bound(_cover, 1, MAX_COVER);
    uint256 priced = bound(_priced, 1, cover);
    (uint256 baseFee, uint256 gasPrice) = _boundGasPrices(_baseFee, _tip);
    uint256 tokenPerEth = bound(_tokenPerEth, 1, MAX_TOKEN_PER_ETH);
    uint256 required = SubsidyMath.required(cover, gasPrice, tokenPerEth);
    uint256 exactProfit = required - SubsidyMath.cost(priced, gasPrice, tokenPerEth);
    _configure(uint128(exactProfit), type(uint128).max);
    _setPrices(baseFee, gasPrice);

    uint256 paid = _quote(exactProfit, priced, tokenPerEth);

    assertEq(exactProfit + paid, required, "the payout does not land on the required payout at the smallest profit");
  }

  function test_GivenAResidueThatLeavesSlack_ThenThePayoutIsOneAboveTheRequiredPayout() external {
    _configure(2, type(uint128).max);
    _setPrices(1, 1);
    uint256 paid = _quote(2, 5, 0.5e18);
    assertEq(paid, 2, "the priced gas costs 2.5 token-wei, floored to 2");
    assertEq(2 + paid, SubsidyMath.required(6, 1, 0.5e18) + 1, "the payout must be 4 for a required 3");
  }

  function test_GivenAResidueThatLeavesNoSlack_ThenThePayoutIsTheRequiredPayout() external {
    _configure(2, type(uint128).max);
    _setPrices(1, 1);
    uint256 paid = _quote(2, 5, 0.75e18);
    assertEq(paid, 3, "the priced gas costs 3.75 token-wei, floored to 3");
    assertEq(2 + paid, SubsidyMath.required(6, 1, 0.75e18), "the payout must be 5 for a required 5");
  }

  function testFuzz_GivenALiveCorner_ThenEveryLowerPriceAndEverySmallerTransactionIsLive(
    uint256 _coverBound,
    uint256 _unpricedBound,
    uint256 _baseFee,
    uint256 _tip,
    uint256 _tokenPerEth,
    uint256[4] memory _slack,
    uint256[5] memory _lower
  ) external {
    uint256 coverBound = bound(_coverBound, 1, MAX_COVER);
    uint256 unpricedBound = bound(_unpricedBound, 0, coverBound);
    (uint256 baseFee, uint256 cornerGasPrice) = _boundGasPrices(_baseFee, _tip);
    uint256 cornerTokenPerEth = bound(_tokenPerEth, 1, MAX_TOKEN_PER_ETH);
    uint256 fee;
    {
      uint256 cornerRequired = SubsidyMath.required(coverBound, cornerGasPrice, cornerTokenPerEth) + 1;
      uint256 cornerCost = SubsidyMath.cost(coverBound - unpricedBound, cornerGasPrice, cornerTokenPerEth);
      uint256 minProfit = cornerRequired > cornerCost ? cornerRequired - cornerCost : 0;
      fee = minProfit + bound(_slack[0], 0, SLACK);
      uint256 minCap = cornerRequired > fee ? cornerRequired - fee : 0;
      uint256 cap = minCap + bound(_slack[2], 0, SLACK);
      _configure(uint128(minProfit + bound(_slack[1], 0, SLACK)), uint128(cap));
      _fundPot(cap + bound(_slack[3], 0, type(uint128).max));
      _setPrices(baseFee, cornerGasPrice);
      uint256 cornerPaid = _quote(fee, coverBound - unpricedBound, cornerTokenPerEth);
      assertGe(fee + cornerPaid, cornerRequired, "the corner is not live with the margin");
    }

    uint256 gasPrice = bound(_lower[0], 1, cornerGasPrice);
    uint256 tip = bound(_lower[1], 0, Math.min(gasPrice, SubsidyMath.MAX_PRIORITY_FEE_WEI));
    uint256 tokenPerEth = bound(_lower[2], 1, cornerTokenPerEth);
    uint256 cover = bound(_lower[3], 0, coverBound);
    uint256 priced = bound(_lower[4], cover > unpricedBound ? cover - unpricedBound : 0, cover);
    _setPrices(gasPrice - tip, gasPrice);

    uint256 paid = _quote(fee, priced, tokenPerEth);

    assertGe(
      fee + paid,
      SubsidyMath.required(cover, gasPrice, tokenPerEth),
      "a transaction within the bounds at a lower price is not live"
    );
  }

  function test_GivenTheFeeAtTheProfit_ThenTheSubsidyIsTheGasCost() external {
    _flat(1e15, type(uint128).max, type(uint128).max);
    assertEq(_quote(1e15, 1000, ETH_2000), 2e15, "fee = profit: the fee pays the profit");
  }

  function test_GivenAFeeBelowTheProfit_ThenTheFeeCapsTheProfit() external {
    _flat(5e15, type(uint128).max, type(uint128).max);
    assertEq(_quote(1e15, 1000, ETH_2000), 2e15, "fee < profit: the profit above the fee is not paid");
    assertEq(_quote(0, 1000, ETH_2000), 2e15, "fee 0: the subsidy pays the gas alone");
  }

  function test_GivenAFeeAboveTheProfit_ThenTheSurplusComesOffTheGasCost() external {
    _flat(1e15, type(uint128).max, type(uint128).max);
    assertEq(_quote(1.5e15, 1000, ETH_2000), 1.5e15, "fee > profit: the fee surplus comes off the gas cost");
  }

  function test_GivenATargetPayoutAtTheFee_ThenTheSubsidyIsZero() external {
    _flat(0, type(uint128).max, type(uint128).max);
    assertEq(_quote(2e15, 1000, ETH_2000), 0, "the fee pays the whole target");
    assertEq(_quote(2e15 - 1, 1000, ETH_2000), 1, "1 token-wei below the target");
    assertEq(_quote(5e15, 1000, ETH_2000), 0, "the fee pays more than the target");
  }

  function test_GivenTheCapBinds_ThenTheSubsidyIsTheCap() external {
    _flat(1e15, 1e15, type(uint128).max);
    assertEq(_quote(1e15, 1000, ETH_2000), 1e15, "the cap binds");
    _configure(1e15, 2e15);
    assertEq(_quote(1e15, 1000, ETH_2000), 2e15, "a cap at the quote does not bind");
  }

  function test_GivenThePotHoldsTheQuote_ThenItPaysTheQuote() external {
    _flat(1e15, type(uint128).max, 2e15);
    assertEq(_quote(1e15, 1000, ETH_2000), 2e15, "a pot that holds the quote pays the quote");
    _fundPot(2e15 - 1);
    assertEq(_quote(1e15, 1000, ETH_2000), 2e15 - 1, "a pot 1 token-wei short pays the pot");
    _fundPot(0);
    assertEq(_quote(1e15, 1000, ETH_2000), 0, "an empty pot pays nothing");
  }

  function test_GivenAFractionalGasCost_ThenItIsRoundedDown() external {
    _configure(0, type(uint128).max);
    _setPrices(1, 1);
    assertEq(_quote(0, 3, 0.5e18), 1, "1.5 token-wei of gas is paid as 1");
    assertEq(_quote(0, 1, 0.5e18), 0, "0.5 token-wei of gas is paid as 0");
  }

  function test_GivenATipBelowTheCap_ThenTheWholeGasPriceIsPriced() external {
    _configure(0, type(uint128).max);
    _setPrices(5 * GWEI, 5.05 gwei);
    assertEq(_quote(0, 123_457, ETH_2324), 1_449_078_142_441_000_000, "a 0.05 gwei tip is priced");
  }

  function test_GivenATipAtTheCap_ThenTheWholeGasPriceIsPriced() external {
    _configure(0, type(uint128).max);
    _setPrices(5 * GWEI, 5.1 gwei);
    assertEq(_quote(0, 123_457, ETH_2324), 1_463_425_450_782_000_000, "a 0.1 gwei tip is priced");
  }

  function test_GivenATipAboveTheCap_ThenTheGasPriceIsPricedAtTheBaseFeePlusTheCap() external {
    _configure(0, type(uint128).max);
    _setPrices(5 * GWEI, 7.3 gwei);
    assertEq(_quote(0, 123_457, ETH_2324), 1_463_425_450_782_000_000, "a tip above 0.1 gwei is priced at 0.1 gwei");
  }

  function test_GivenNoPricedGas_ThenTheSubsidyIsZero() external {
    _flat(1e15, type(uint128).max, type(uint128).max);
    assertEq(_quote(0, 0, ETH_2000), 0, "no priced gas pays nothing");
  }

  function testFuzz_GivenAnyInputIncludingALargeTargetPayout_ThenTheSubsidyIsExactlyTheFeeOffsetQuote(
    uint256 _fee,
    uint256 _gas,
    uint256 _tokenPerEth,
    uint128 _profit,
    uint128 _cap,
    uint256 _pot,
    uint256 _baseFee,
    uint256 _txGasPrice
  ) external {
    uint256 fee = bound(_fee, 0, type(uint128).max);
    uint256 gas = bound(_gas, 0, type(uint64).max);
    uint256 tokenPerEth = bound(_tokenPerEth, 0, type(uint128).max);
    uint256 pot = bound(_pot, 0, type(uint128).max);
    _configure(_profit, _cap);
    _fundPot(pot);
    _setPrices(
      bound(_baseFee, 0, type(uint64).max - SubsidyMath.MAX_PRIORITY_FEE_WEI), bound(_txGasPrice, 0, type(uint64).max)
    );

    uint256 paid = _quote(fee, gas, tokenPerEth);

    uint256 gasCost = SubsidyMath.cost(gas, SubsidyMath.pricedGasPrice(block.basefee, tx.gasprice), tokenPerEth);
    assertEq(
      paid,
      _feeOffsetQuote(gasCost, fee, _profit, _cap, pot),
      "the subsidy is not the gas cost plus the capped profit less the fee, limited by the cap and the pot"
    );
  }

  function test_GivenATargetPayoutAbove2To128_ThenTheSubsidyIsTheCap() external {
    _configure(uint128(2 ** 127), 40e18);
    _setPrices(1e18, 1e18);
    assertEq(
      _quote(2 ** 127, 1, 2 ** 127 + 1), 40e18, "a target payout of 2^128 + 1 token-wei pays the cap of 40 tokens"
    );
  }

  function testFuzz_GivenATokenWithAnyDecimals_ThenTheTokenWeiPerEthScalesWithItsDecimals(
    uint256 _decimals,
    uint128 _usdPerEth
  ) external {
    uint8 decimals = uint8(bound(_decimals, 0, 36));
    (DepositSubsidyHarness other,) = _subsidyWithDecimals(decimals);
    feed.set(int256(uint256(_usdPerEth)), block.timestamp);
    assertEq(
      other.exposedTokenWeiPerEth(),
      Math.mulDiv(_usdPerEth, 10 ** decimals, 1e8),
      "the token wei per ETH does not scale with the decimals of the token"
    );
  }

  function test_GivenASixDecimalToken_ThenTheQuotePaysTheGasInTheUnitsOfTheToken() external {
    (DepositSubsidyHarness other, PotToken sixDecimals) = _subsidyWithDecimals(6);
    sixDecimals.set(address(other), type(uint128).max, 1);
    vm.prank(OWNER);
    other.setDepositConfig(0, type(uint128).max, 0);
    feed.set(2000e8, block.timestamp);
    _setPrices(GWEI, GWEI);
    assertEq(other.quoteSubsidy(0, 125_000), 250_000, "125,000 gas at 1 gwei and ETH at $2,000 is $0.25: 250,000 units");
  }

  function testFuzz_GivenAnyFeedRound_ThenThePriceIsReadOnlyWhileItIsFreshAndNotNegative(
    int128 _answer,
    uint256 _now,
    int256 _age
  ) external {
    uint256 nowTs = bound(_now, 2 * MAX_PRICE_AGE, type(uint64).max);
    int256 age = bound(_age, -int256(2 * MAX_PRICE_AGE), int256(2 * MAX_PRICE_AGE));
    uint256 updatedAt = uint256(int256(nowTs) - age);
    vm.warp(nowTs);
    feed.set(_answer, updatedAt);

    bool usable = _answer >= 0 && age >= 0 && uint256(age) <= MAX_PRICE_AGE;
    assertEq(
      subsidy.exposedTokenWeiPerEth(),
      usable ? uint256(int256(_answer)) * 1e10 : 0,
      "the subsidy reads a feed answer that is negative, dated ahead or older than the max age"
    );
  }

  function test_GivenAFeedAtTheMaxAge_ThenTheQuoteIsPriced() external {
    _quoteAtFeedAge(int256(MAX_PRICE_AGE), 2000e8);
    assertEq(subsidy.quoteSubsidy(0, 1000), 2e15, "a feed at the max age is not read");
  }

  function test_GivenAFeedOneSecondPastTheMaxAge_ThenTheQuoteIsZero() external {
    _quoteAtFeedAge(int256(MAX_PRICE_AGE) + 1, 2000e8);
    assertEq(subsidy.quoteSubsidy(0, 1000), 0, "a stale feed is read");
  }

  function test_GivenAFeedDatedOneSecondAhead_ThenTheQuoteIsZero() external {
    _quoteAtFeedAge(-1, 2000e8);
    assertEq(subsidy.quoteSubsidy(0, 1000), 0, "a feed dated ahead is read");
  }

  function test_GivenAZeroFeedAnswer_ThenTheQuoteIsZero() external {
    _quoteAtFeedAge(0, 0);
    assertEq(subsidy.quoteSubsidy(0, 1000), 0, "a zero feed answer prices gas");
  }

  function test_GivenANegativeFeedAnswer_ThenTheQuoteIsZero() external {
    _quoteAtFeedAge(0, -1);
    assertEq(subsidy.quoteSubsidy(0, 1000), 0, "a negative feed answer is read");
  }

  function _quoteAtFeedAge(int256 _age, int256 _answer) internal {
    _flat(0, type(uint128).max, type(uint128).max);
    uint256 nowTs = 10 * MAX_PRICE_AGE;
    vm.warp(nowTs);
    feed.set(_answer, uint256(int256(nowTs) - _age));
  }

  function _feeOffsetQuote(uint256 _gasCost, uint256 _fee, uint256 _profit, uint256 _cap, uint256 _pot)
    internal
    pure
    returns (uint256)
  {
    uint256 target = _gasCost + Math.min(_profit, _fee);
    return target > _fee ? Math.min(Math.min(target - _fee, _cap), _pot) : 0;
  }

  function _subsidyWithDecimals(uint8 _decimals) internal returns (DepositSubsidyHarness other, PotToken otherToken) {
    otherToken = new PotToken(_decimals);
    PortalStub portal = new PortalStub(IERC20(address(otherToken)));
    other = new DepositSubsidyHarness(OWNER, address(portal), address(executor), feed);
  }

  function _envelope(
    uint256 _cover,
    uint256 _priced,
    uint256 _baseFee,
    uint256 _tip,
    uint256 _tokenPerEth,
    uint256[4] memory _slack,
    uint256 _margin
  ) internal pure returns (Envelope memory e) {
    e.cover = bound(_cover, 1, MAX_COVER);
    e.priced = bound(_priced, 1, e.cover);
    (e.baseFee, e.gasPrice) = _boundGasPrices(_baseFee, _tip);
    e.tokenPerEth = bound(_tokenPerEth, 1, MAX_TOKEN_PER_ETH);
    uint256 unreimbursed = (e.cover - e.priced) * e.gasPrice * e.tokenPerEth;
    uint256 minProfit = Math.ceilDiv(unreimbursed + _margin, WAD);
    e.profit = minProfit + bound(_slack[0], 0, SLACK);
    e.fee = minProfit + bound(_slack[1], 0, SLACK);
    uint256 required = SubsidyMath.required(e.cover, e.gasPrice, e.tokenPerEth);
    uint256 minCap = required > e.fee ? required - e.fee : 0;
    e.cap = minCap + bound(_slack[2], 0, SLACK);
    e.pot = e.cap + bound(_slack[3], 0, type(uint128).max);
  }
}
