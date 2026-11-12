// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {
  DepositSubsidyHarness,
  MigrationSubsidyHarness,
  PotToken,
  PortalStub,
  FeedStub,
  ExecutorStub
} from "@test/subsidy-check/subsidies/SubsidyHarnesses.sol";

library SubsidyMath {
  uint256 internal constant WAD = 1e18;
  uint256 internal constant MAX_PRIORITY_FEE_WEI = OxideConstants.MAX_PRIORITY_FEE_WEI;

  function required(uint256 _cover, uint256 _gasPrice, uint256 _tokenPerEth) internal pure returns (uint256) {
    return Math.mulDiv(_cover * _gasPrice, _tokenPerEth, WAD, Math.Rounding.Ceil);
  }

  function cost(uint256 _gas, uint256 _gasPrice, uint256 _tokenPerEth) internal pure returns (uint256) {
    return Math.mulDiv(_gas * _gasPrice, _tokenPerEth, WAD);
  }

  function pricedGasPrice(uint256 _baseFee, uint256 _txGasPrice) internal pure returns (uint256) {
    return Math.min(_txGasPrice, _baseFee + MAX_PRIORITY_FEE_WEI);
  }

  function charged(uint256 _gross, uint256 _refund, uint256 _calldataFloor) internal pure returns (uint256) {
    return Math.max(_gross - Math.min(_refund, _gross / 5), _calldataFloor);
  }
}

abstract contract SubsidyPrices is Test {
  function _setPrices(uint256 _baseFee, uint256 _txGasPrice) internal {
    vm.fee(_baseFee);
    vm.txGasPrice(_txGasPrice);
  }

  function _boundGasPrices(uint256 _baseFee, uint256 _tip) internal pure returns (uint256 baseFee, uint256 gasPrice) {
    baseFee = bound(_baseFee, 0, type(uint64).max - SubsidyMath.MAX_PRIORITY_FEE_WEI);
    gasPrice = baseFee + bound(_tip, baseFee == 0 ? 1 : 0, SubsidyMath.MAX_PRIORITY_FEE_WEI);
  }
}

contract DepositSubsidySetup is SubsidyPrices {
  address internal constant OWNER = address(0xA11CE);

  PotToken internal token;
  FeedStub internal feed;
  ExecutorStub internal executor;
  DepositSubsidyHarness internal subsidy;

  function setUp() public virtual {
    token = new PotToken(18);
    feed = new FeedStub();
    executor = new ExecutorStub();
    PortalStub portal = new PortalStub(IERC20(address(token)));
    subsidy = new DepositSubsidyHarness(OWNER, address(portal), address(executor), feed);
    token.set(address(subsidy), type(uint128).max, 1);
  }

  function _configure(uint128 _targetRelayerProfit, uint128 _maxSubsidy) internal {
    vm.prank(OWNER);
    subsidy.setDepositConfig(_targetRelayerProfit, _maxSubsidy, 0);
  }

  function _fundPot(uint256 _pot) internal {
    token.set(address(subsidy), _pot, token.otherBalance());
  }
}

contract MigrationSubsidySetup is SubsidyPrices {
  address internal constant OWNER = address(0xA11CE);
  address internal constant EXECUTOR = address(0xE1);

  PotToken internal token;
  FeedStub internal feed;
  MigrationSubsidyHarness internal subsidy;

  function setUp() public virtual {
    token = new PotToken(18);
    feed = new FeedStub();
    PortalStub source = new PortalStub(IERC20(address(token)));
    subsidy = new MigrationSubsidyHarness(OWNER, IERC20(address(token)), address(source), EXECUTOR, feed);
    token.set(address(subsidy), type(uint128).max, 1);
  }

  function _configure(uint128 _targetRelayerProfit, uint128 _maxSubsidy) internal {
    vm.prank(OWNER);
    subsidy.setConfig(_targetRelayerProfit, _maxSubsidy, 0);
  }

  function _fundPot(uint256 _pot) internal {
    token.set(address(subsidy), _pot, token.otherBalance());
  }
}
