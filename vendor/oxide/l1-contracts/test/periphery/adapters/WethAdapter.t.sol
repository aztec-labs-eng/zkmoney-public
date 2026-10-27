// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {WethAdapter} from "@periphery/adapters/WethAdapter.sol";
import {MockWETH9} from "@test/mocks/MockWETH9.sol";

contract WethAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT = 3 ether;
  uint256 internal constant FIXED_AMOUNT = 1 ether;

  MockWETH9 internal weth;
  WethAdapter internal adapter;
  address internal recipient = makeAddr("recipient");

  function setUp() external {
    weth = new MockWETH9();
    adapter = new WethAdapter(IWETH9(address(weth)));
    vm.deal(address(this), 100 ether);
  }

  function test_WrapOfMaxSendsTheWholeEthBalanceAsWeth() external {
    vm.deal(address(adapter), AMOUNT);

    adapter.wrapEth(MAX, recipient);

    assertEq(weth.balanceOf(recipient), AMOUNT);
    assertEq(address(adapter).balance, 0);
    assertEq(weth.balanceOf(address(adapter)), 0);
  }

  function test_WrapOfAFixedAmountLeavesTheRest() external {
    vm.deal(address(adapter), AMOUNT);

    adapter.wrapEth(FIXED_AMOUNT, recipient);

    assertEq(weth.balanceOf(recipient), FIXED_AMOUNT);
    assertEq(address(adapter).balance, AMOUNT - FIXED_AMOUNT);
  }

  function test_UnwrapOfMaxSendsTheWholeBalanceAsEth() external {
    _fundAdapter(AMOUNT);

    adapter.unwrapWeth(MAX, recipient);

    assertEq(recipient.balance, AMOUNT);
    assertEq(weth.balanceOf(address(adapter)), 0);
    assertEq(address(adapter).balance, 0);
  }

  function test_UnwrapOfAFixedAmountLeavesTheRest() external {
    _fundAdapter(AMOUNT);

    adapter.unwrapWeth(FIXED_AMOUNT, recipient);

    assertEq(recipient.balance, FIXED_AMOUNT);
    assertEq(weth.balanceOf(address(adapter)), AMOUNT - FIXED_AMOUNT);
  }

  function _fundAdapter(uint256 _amount) internal {
    weth.deposit{value: _amount}();
    weth.transfer(address(adapter), _amount);
  }
}
