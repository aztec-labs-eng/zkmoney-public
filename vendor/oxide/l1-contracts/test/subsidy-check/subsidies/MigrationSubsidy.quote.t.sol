// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {MigrationSubsidyHarness, PotToken, PortalStub} from "@test/subsidy-check/subsidies/SubsidyHarnesses.sol";
import {MigrationSubsidySetup, SubsidyMath} from "@test/subsidy-check/subsidies/SubsidySetup.sol";

contract MigrationSubsidyQuoteTest is MigrationSubsidySetup {
  uint256 internal constant WAD = 1e18;
  uint256 internal constant GWEI = 1e9;
  uint256 internal constant MAX_COVER = 2 ** 24;
  uint256 internal constant MAX_TOKEN_PER_ETH = 2 ** 96;
  uint256 internal constant SLACK = 2 ** 126;
  uint256 internal constant ETH_2000 = 2000e18;

  function testFuzz_GivenAnyInput_ThenTheSubsidyIsAtMostTheGasCostPlusTheProfitTheCapAndThePot(
    uint256 _gas,
    uint256 _tokenPerEth,
    uint128 _profit,
    uint128 _cap,
    uint256 _pot,
    uint256 _baseFee,
    uint256 _txGasPrice
  ) external {
    uint256 gas = bound(_gas, 0, 2 ** 32);
    uint256 tokenPerEth = bound(_tokenPerEth, 0, type(uint128).max);
    uint256 pot = bound(_pot, 0, type(uint128).max);
    uint256 baseFee = bound(_baseFee, 0, type(uint64).max - SubsidyMath.MAX_PRIORITY_FEE_WEI);
    uint256 txGasPrice = bound(_txGasPrice, 0, type(uint64).max);
    _configure(_profit, _cap);
    _fundPot(pot);
    _setPrices(baseFee, txGasPrice);

    uint256 paid = subsidy.exposedQuote(gas, tokenPerEth);

    uint256 price = SubsidyMath.pricedGasPrice(baseFee, txGasPrice);
    assertLe(paid, SubsidyMath.cost(gas, price, tokenPerEth) + _profit, "the subsidy pays more than gas plus profit");
    assertLe(paid, _cap, "the subsidy pays more than the cap");
    assertLe(paid, pot, "the subsidy pays more than the pot holds");
    if (gas == 0 || tokenPerEth == 0) {
      assertEq(paid, 0, "no priced gas or no token price must pay nothing");
    }
  }

  function testFuzz_GivenTheEnvelope_ThenTheSubsidyPaysTheRequiredPayout(
    uint256 _cover,
    uint256 _priced,
    uint256 _baseFee,
    uint256 _tip,
    uint256 _tokenPerEth,
    uint256[3] memory _slack
  ) external {
    uint256 cover = bound(_cover, 1, MAX_COVER);
    uint256 priced = bound(_priced, 1, cover);
    (uint256 baseFee, uint256 gasPrice) = _boundGasPrices(_baseFee, _tip);
    uint256 tokenPerEth = bound(_tokenPerEth, 1, MAX_TOKEN_PER_ETH);
    uint256 unreimbursed = (cover - priced) * gasPrice * tokenPerEth;
    uint256 profit = Math.ceilDiv(unreimbursed + WAD, WAD) + bound(_slack[0], 0, SLACK);
    uint256 required = SubsidyMath.required(cover, gasPrice, tokenPerEth);
    uint256 cap = required + bound(_slack[1], 0, SLACK);
    _configure(uint128(profit), uint128(cap));
    _fundPot(cap + bound(_slack[2], 0, type(uint128).max));
    _setPrices(baseFee, gasPrice);

    assertGe(subsidy.exposedQuote(priced, tokenPerEth), required, "inside the envelope the relayer is short");
  }

  function testFuzz_GivenALiveCorner_ThenEveryLowerPriceAndEverySmallerTransactionIsLive(
    uint256 _coverBound,
    uint256 _unpricedBound,
    uint256 _baseFee,
    uint256 _tip,
    uint256 _tokenPerEth,
    uint256[3] memory _slack,
    uint256[5] memory _lower
  ) external {
    uint256 coverBound = bound(_coverBound, 1, MAX_COVER);
    uint256 unpricedBound = bound(_unpricedBound, 0, coverBound - 1);
    (uint256 baseFee, uint256 cornerGasPrice) = _boundGasPrices(_baseFee, _tip);
    uint256 cornerTokenPerEth = bound(_tokenPerEth, 1, MAX_TOKEN_PER_ETH);
    {
      uint256 cornerRequired = SubsidyMath.required(coverBound, cornerGasPrice, cornerTokenPerEth) + 1;
      uint256 cornerCost = SubsidyMath.cost(coverBound - unpricedBound, cornerGasPrice, cornerTokenPerEth);
      uint256 profit = (cornerRequired > cornerCost ? cornerRequired - cornerCost : 0) + bound(_slack[0], 0, SLACK);
      uint256 cap = cornerRequired + bound(_slack[1], 0, SLACK);
      _configure(uint128(profit), uint128(cap));
      _fundPot(cap + bound(_slack[2], 0, type(uint128).max));
      _setPrices(baseFee, cornerGasPrice);
      assertGe(
        subsidy.exposedQuote(coverBound - unpricedBound, cornerTokenPerEth),
        cornerRequired,
        "the corner is not live with the margin"
      );
    }

    uint256 gasPrice = bound(_lower[0], 1, cornerGasPrice);
    uint256 tip = bound(_lower[1], 0, Math.min(gasPrice, SubsidyMath.MAX_PRIORITY_FEE_WEI));
    uint256 tokenPerEth = bound(_lower[2], 1, cornerTokenPerEth);
    uint256 cover = bound(_lower[3], 1, coverBound);
    uint256 priced = bound(_lower[4], cover > unpricedBound + 1 ? cover - unpricedBound : 1, cover);
    _setPrices(gasPrice - tip, gasPrice);

    assertGe(
      subsidy.exposedQuote(priced, tokenPerEth),
      SubsidyMath.required(cover, gasPrice, tokenPerEth),
      "a migration within the bounds at a lower price is not live"
    );
  }

  function test_GivenNoPricedGasOrNoTokenPrice_ThenTheSubsidyIsZero() external {
    _configure(1e15, type(uint128).max);
    _setPrices(GWEI, GWEI);
    assertEq(subsidy.exposedQuote(0, ETH_2000), 0, "no priced gas pays the profit");
    assertEq(subsidy.exposedQuote(1000, 0), 0, "no token price pays the profit");
  }

  function test_GivenAZeroGasPrice_ThenTheSubsidyIsTheProfit() external {
    _configure(1e15, type(uint128).max);
    _setPrices(0, 0);
    assertEq(subsidy.exposedQuote(1000, ETH_2000), 1e15, "a zero gas price pays the profit alone");
  }

  function test_GivenAProfit_ThenTheSubsidyIsTheGasCostPlusTheProfit() external {
    _configure(1e15, type(uint128).max);
    _setPrices(GWEI, GWEI);
    assertEq(subsidy.exposedQuote(1000, ETH_2000), 3e15, "the gas cost plus the profit");
  }

  function test_GivenTheCapOrThePotBinds_ThenTheSubsidyIsClamped() external {
    _configure(1e15, 2.5e15);
    _setPrices(GWEI, GWEI);
    assertEq(subsidy.exposedQuote(1000, ETH_2000), 2.5e15, "the cap binds");
    _configure(1e15, type(uint128).max);
    _fundPot(3e15);
    assertEq(subsidy.exposedQuote(1000, ETH_2000), 3e15, "a pot that holds the quote pays the quote");
    _fundPot(1e15);
    assertEq(subsidy.exposedQuote(1000, ETH_2000), 1e15, "a partly funded pot pays the pot");
  }

  function test_GivenAFractionalGasCost_ThenItIsRoundedDown() external {
    _configure(0, type(uint128).max);
    _setPrices(1, 1);
    assertEq(subsidy.exposedQuote(3, 0.5e18), 1, "1.5 token-wei of gas is paid as 1");
  }

  function test_GivenATipAboveTheCap_ThenTheGasPriceIsCappedAtTheBaseFeePlusTheCap() external {
    _setPrices(2 * GWEI, 3 * GWEI);
    assertEq(subsidy.exposedCappedGasPrice(), 2.1 gwei, "a tip above 0.1 gwei is priced at 0.1 gwei");
    _setPrices(2 * GWEI, 2.1 gwei);
    assertEq(subsidy.exposedCappedGasPrice(), 2.1 gwei, "a tip of 0.1 gwei is priced");
    _setPrices(2 * GWEI, 2.05 gwei);
    assertEq(subsidy.exposedCappedGasPrice(), 2.05 gwei, "a tip below 0.1 gwei is priced");
  }

  function testFuzz_GivenAnyInputIncludingALargePayout_ThenTheSubsidyIsExactlyTheGasCostPlusTheProfit(
    uint256 _gas,
    uint256 _tokenPerEth,
    uint128 _profit,
    uint128 _cap,
    uint256 _pot,
    uint256 _baseFee,
    uint256 _txGasPrice
  ) external {
    uint256 gas = bound(_gas, 0, type(uint64).max);
    uint256 tokenPerEth = bound(_tokenPerEth, 0, type(uint128).max);
    uint256 pot = bound(_pot, 0, type(uint128).max);
    _configure(_profit, _cap);
    _fundPot(pot);
    _setPrices(
      bound(_baseFee, 0, type(uint64).max - SubsidyMath.MAX_PRIORITY_FEE_WEI), bound(_txGasPrice, 0, type(uint64).max)
    );

    uint256 paid = subsidy.exposedQuote(gas, tokenPerEth);

    uint256 quoted = gas == 0 || tokenPerEth == 0
      ? 0
      : SubsidyMath.cost(gas, SubsidyMath.pricedGasPrice(block.basefee, tx.gasprice), tokenPerEth) + _profit;
    assertEq(
      paid,
      Math.min(Math.min(quoted, _cap), pot),
      "the subsidy is not the gas cost plus the profit, limited by the cap and the pot"
    );
  }

  function testFuzz_GivenATokenWithAnyDecimals_ThenTheTokenWeiPerEthScalesWithItsDecimals(
    uint256 _decimals,
    uint128 _usdPerEth
  ) external {
    uint8 decimals = uint8(bound(_decimals, 0, 36));
    (MigrationSubsidyHarness other,) = _subsidyWithDecimals(decimals);
    feed.set(int256(uint256(_usdPerEth)), block.timestamp);
    assertEq(
      other.exposedTokenWeiPerEth(),
      Math.mulDiv(_usdPerEth, 10 ** decimals, 1e8),
      "the token wei per ETH does not scale with the decimals of the token"
    );
  }

  function test_GivenASixDecimalToken_ThenTheQuotePaysTheGasInTheUnitsOfTheToken() external {
    (MigrationSubsidyHarness other, PotToken sixDecimals) = _subsidyWithDecimals(6);
    sixDecimals.set(address(other), type(uint128).max, 1);
    vm.prank(OWNER);
    other.setConfig(0, type(uint128).max, 0);
    feed.set(2000e8, block.timestamp);
    _setPrices(GWEI, GWEI);
    assertEq(
      other.exposedQuote(125_000, other.exposedTokenWeiPerEth()),
      250_000,
      "125,000 gas at 1 gwei and ETH at $2,000 is $0.25: 250,000 units"
    );
  }

  function _subsidyWithDecimals(uint8 _decimals) internal returns (MigrationSubsidyHarness other, PotToken otherToken) {
    otherToken = new PotToken(_decimals);
    PortalStub source = new PortalStub(IERC20(address(otherToken)));
    other = new MigrationSubsidyHarness(OWNER, IERC20(address(otherToken)), address(source), EXECUTOR, feed);
  }
}
