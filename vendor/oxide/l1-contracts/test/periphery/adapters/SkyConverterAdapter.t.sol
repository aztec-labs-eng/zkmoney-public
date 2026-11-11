// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {SkyConverterAdapter} from "@periphery/adapters/SkyConverterAdapter.sol";
import {MockDaiUsds} from "@test/mocks/MockDaiUsds.sol";

contract SkyConverterAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT = 1000e18;
  uint256 internal constant FIXED_AMOUNT = 400e18;

  TestERC20 internal dai;
  TestERC20 internal usds;
  MockDaiUsds internal converter;
  SkyConverterAdapter internal adapter;
  address internal recipient = makeAddr("recipient");

  function setUp() external {
    dai = new TestERC20("DAI", "DAI", address(this));
    usds = new TestERC20("USDS", "USDS", address(this));
    converter = new MockDaiUsds(dai, usds, address(this));
    dai.addMinter(address(converter));
    usds.addMinter(address(converter));
    adapter = new SkyConverterAdapter(converter);
  }

  function test_DaiToUsdsOfMaxConvertsTheWholeDaiBalance() external {
    dai.mint(address(adapter), AMOUNT);

    adapter.daiToUsds(MAX, recipient);

    assertEq(usds.balanceOf(recipient), AMOUNT);
    assertEq(dai.balanceOf(address(adapter)), 0);
  }

  function test_DaiToUsdsOfAFixedAmountLeavesTheRestInTheAdapter() external {
    dai.mint(address(adapter), AMOUNT);

    adapter.daiToUsds(FIXED_AMOUNT, recipient);

    assertEq(usds.balanceOf(recipient), FIXED_AMOUNT);
    assertEq(dai.balanceOf(address(adapter)), AMOUNT - FIXED_AMOUNT);
  }

  function test_UsdsToDaiOfMaxConvertsTheWholeUsdsBalance() external {
    usds.mint(address(adapter), AMOUNT);

    adapter.usdsToDai(MAX, recipient);

    assertEq(dai.balanceOf(recipient), AMOUNT);
    assertEq(usds.balanceOf(address(adapter)), 0);
  }

  function test_UsdsToDaiOfAFixedAmountLeavesTheRestInTheAdapter() external {
    usds.mint(address(adapter), AMOUNT);

    adapter.usdsToDai(FIXED_AMOUNT, recipient);

    assertEq(dai.balanceOf(recipient), FIXED_AMOUNT);
    assertEq(usds.balanceOf(address(adapter)), AMOUNT - FIXED_AMOUNT);
  }

  function test_AZeroRecipientReverts() external {
    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.daiToUsds(MAX, address(0));

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.usdsToDai(MAX, address(0));
  }
}
