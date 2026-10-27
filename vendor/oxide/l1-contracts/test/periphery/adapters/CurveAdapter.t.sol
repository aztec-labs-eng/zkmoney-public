// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {CurveAdapter} from "@periphery/adapters/CurveAdapter.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";

contract CurveAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT_IN = 1000e18;
  uint256 internal constant FIXED_AMOUNT_IN = 400e18;
  uint256 internal constant USDC_RATE = 99e16;

  TestERC20 internal dai;
  TestERC20 internal usdc;
  MockCurve3Pool internal pool;
  CurveAdapter internal adapter;
  address internal recipient = makeAddr("recipient");

  function setUp() external {
    dai = new TestERC20("DAI", "DAI", address(this));
    usdc = new TestERC20("USDC", "USDC", address(this));
    pool = new MockCurve3Pool();
    pool.setCoins(address(dai), address(usdc), address(0));
    pool.setRate(address(usdc), USDC_RATE);
    usdc.mint(address(pool), 1_000_000e18);
    adapter = new CurveAdapter();
  }

  function test_MaxSwapsTheWholeBalance() external {
    dai.mint(address(adapter), AMOUNT_IN);

    adapter.curveExchange(pool, 0, 1, MAX, 0, recipient);

    assertEq(pool.lastDx(), AMOUNT_IN);
    assertEq(pool.lastI(), 0);
    assertEq(pool.lastJ(), 1);
    assertEq(usdc.balanceOf(recipient), (AMOUNT_IN * USDC_RATE) / 1e18);
    assertEq(dai.balanceOf(address(adapter)), 0);
  }

  function test_AFixedAmountLeavesTheRestInTheAdapter() external {
    dai.mint(address(adapter), AMOUNT_IN);

    adapter.curveExchange(pool, 0, 1, FIXED_AMOUNT_IN, 0, recipient);

    assertEq(pool.lastDx(), FIXED_AMOUNT_IN);
    assertEq(dai.balanceOf(address(adapter)), AMOUNT_IN - FIXED_AMOUNT_IN);
  }

  function test_TheMinOutIsPassedToThePool() external {
    dai.mint(address(adapter), AMOUNT_IN);
    uint256 expectedOut = (AMOUNT_IN * USDC_RATE) / 1e18;

    adapter.curveExchange(pool, 0, 1, MAX, expectedOut, recipient);

    assertEq(pool.lastMinDy(), expectedOut);
  }
}
