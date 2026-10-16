// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {MockDaiUsds} from "@test/periphery/experiments/sky/mocks/MockDaiUsds.sol";
import {MockSUsds} from "@test/periphery/experiments/sky/mocks/MockSUsds.sol";

contract SkyMocksTest is Test {
  uint256 internal constant WAD = 1e18;
  uint256 internal constant ONE_PERCENT_PER_DAY = WAD / 100 / 1 days;

  address internal constant USER = address(0xBEEF);

  TestERC20 internal dai;
  TestERC20 internal usds;
  MockSUsds internal sUsds;
  MockDaiUsds internal converter;

  function setUp() public {
    dai = new TestERC20("Dai Stablecoin", "DAI", address(this));
    usds = new TestERC20("USDS Stablecoin", "USDS", address(this));
    sUsds = new MockSUsds(usds, address(this));
    converter = new MockDaiUsds(dai, usds, address(this));
    usds.addMinter(address(sUsds));
  }

  function test_pricePerShare_isConstantWithoutRate() public {
    vm.warp(block.timestamp + 365 days);
    assertEq(sUsds.pricePerShare(), WAD);
  }

  function test_pricePerShare_accruesAtTheRate() public {
    sUsds.setRatePerSecond(ONE_PERCENT_PER_DAY);
    vm.warp(block.timestamp + 1 days);
    assertApproxEqAbs(sUsds.pricePerShare(), 1.01e18, 1e6);
    vm.warp(block.timestamp + 1 days);
    assertApproxEqAbs(sUsds.pricePerShare(), 1.02e18, 1e6);
  }

  function test_setRatePerSecond_keepsTheAccruedPrice() public {
    sUsds.setRatePerSecond(ONE_PERCENT_PER_DAY);
    vm.warp(block.timestamp + 1 days);
    uint256 accrued = sUsds.pricePerShare();

    sUsds.setRatePerSecond(0);
    assertEq(sUsds.chi(), accrued);
    vm.warp(block.timestamp + 30 days);
    assertEq(sUsds.pricePerShare(), accrued);
  }

  function test_setPricePerShare_restartsAccrualFromTheNewPrice() public {
    sUsds.setRatePerSecond(ONE_PERCENT_PER_DAY);
    vm.warp(block.timestamp + 1 days);
    sUsds.setPricePerShare(1.25e18);
    assertEq(sUsds.pricePerShare(), 1.25e18);

    vm.warp(block.timestamp + 1 days);
    assertApproxEqAbs(sUsds.pricePerShare(), 1.2625e18, 1e6);
  }

  function test_setPricePerShare_revertsOnDecrease() public {
    sUsds.setPricePerShare(1.25e18);
    vm.expectRevert(MockSUsds.MockSUsds__PriceDecrease.selector);
    sUsds.setPricePerShare(1.24e18);
  }

  function test_setPricePerShare_revertsBelowTheAccruedPrice() public {
    sUsds.setRatePerSecond(ONE_PERCENT_PER_DAY);
    vm.warp(block.timestamp + 1 days);
    vm.expectRevert(MockSUsds.MockSUsds__PriceDecrease.selector);
    sUsds.setPricePerShare(1.005e18);
  }

  function test_setters_areOwnerOnly() public {
    vm.startPrank(USER);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, USER));
    sUsds.setRatePerSecond(1);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, USER));
    sUsds.setPricePerShare(2e18);
    vm.stopPrank();
  }

  function test_redeem_paysTheAccruedYield() public {
    uint256 shares = _deposit(100e18);
    sUsds.setRatePerSecond(ONE_PERCENT_PER_DAY);
    vm.warp(block.timestamp + 1 days);

    vm.prank(USER);
    uint256 assets = sUsds.redeem(shares, USER, USER);
    assertApproxEqAbs(assets, 101e18, 1e9);
    assertEq(usds.balanceOf(USER), assets);
  }

  function test_converter_paysFromWhatItHoldsWithoutMinting() public {
    usds.addMinter(address(converter));
    dai.mint(USER, 100e18);
    vm.startPrank(USER);
    dai.approve(address(converter), 100e18);
    converter.daiToUsds(USER, 100e18);
    usds.approve(address(converter), 100e18);
    converter.usdsToDai(USER, 100e18);
    vm.stopPrank();

    assertEq(dai.balanceOf(USER), 100e18);
    assertEq(dai.totalSupply(), 100e18);
  }

  function test_converter_mintsOnlyTheShortfall() public {
    dai.addMinter(address(converter));
    dai.mint(address(converter), 40e18);
    usds.mint(USER, 100e18);
    vm.startPrank(USER);
    usds.approve(address(converter), 100e18);
    converter.usdsToDai(USER, 100e18);
    vm.stopPrank();

    assertEq(dai.balanceOf(USER), 100e18);
    assertEq(dai.balanceOf(address(converter)), 0);
    assertEq(dai.totalSupply(), 100e18);
  }

  function _deposit(uint256 _usdsAmount) internal returns (uint256 shares) {
    usds.mint(USER, _usdsAmount);
    vm.startPrank(USER);
    usds.approve(address(sUsds), _usdsAmount);
    shares = sUsds.deposit(_usdsAmount, USER);
    vm.stopPrank();
  }
}
