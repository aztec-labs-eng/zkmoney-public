// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {Errors} from "@periphery/Errors.sol";
import {MockOperation} from "../mocks/MockOperation.sol";

contract ReentrantOperation {
  OperationExecutor internal immutable EXECUTOR;
  IERC20 internal immutable TOKEN;
  bool public executed;

  constructor(OperationExecutor _executor, IERC20 _token) {
    EXECUTOR = _executor;
    TOKEN = _token;
  }

  function run() external {
    executed = true;
    EXECUTOR.execute(address(this), abi.encodeCall(this.noop, ()), TOKEN, 0, 0, 0);
  }

  function noop() external {}
}

contract OperationExecutorTest is Test {
  uint256 internal constant REWARD = 1000;
  address internal constant RELAYER = address(0xbeef);

  TestERC20 internal token;
  OperationExecutor internal executor;
  MockOperation internal operation;

  function setUp() public {
    token = new TestERC20("Test", "TST", address(this));
    executor = new OperationExecutor();
    operation = new MockOperation(IERC20(address(token)), REWARD);
    token.mint(address(operation), REWARD);
  }

  function _executeCall(uint256 minPayout) internal returns (uint256) {
    return _executeCall(minPayout, 0, 0);
  }

  function _executeCall(uint256 minPayout, uint256 gasToCover, uint256 tokenWeiPerEth) internal returns (uint256) {
    return executor.execute(
      address(operation),
      abi.encodeCall(MockOperation.run, ()),
      IERC20(address(token)),
      minPayout,
      gasToCover,
      tokenWeiPerEth
    );
  }

  function test_executePaysPayoutToCaller() public {
    vm.prank(RELAYER);
    uint256 payout = _executeCall(REWARD);

    assertEq(payout, REWARD);
    assertEq(token.balanceOf(RELAYER), REWARD);
    assertEq(token.balanceOf(address(executor)), 0);
    assertTrue(operation.executed());
  }

  function test_executeDoesNotSweepPreexistingBalance() public {
    token.mint(address(executor), 5);

    vm.prank(RELAYER);
    uint256 payout = _executeCall(REWARD);

    assertEq(payout, REWARD);
    assertEq(token.balanceOf(RELAYER), REWARD);
    assertEq(token.balanceOf(address(executor)), 5);
  }

  function test_executeRevertsOnPayoutBelowMinimum() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.OperationExecutor__InsufficientPayout.selector, REWARD, REWARD + 1));
    vm.prank(RELAYER);
    _executeCall(REWARD + 1);
  }

  function test_executeRunAndPaySplitsRewardWithRecipient() public {
    address recipient = address(0xcafe);

    vm.prank(RELAYER);
    uint256 payout = executor.execute(
      address(operation), abi.encodeCall(MockOperation.runAndPay, (recipient)), IERC20(address(token)), REWARD / 2, 0, 0
    );

    assertEq(payout, REWARD / 2);
    assertEq(token.balanceOf(RELAYER), REWARD / 2);
    assertEq(token.balanceOf(recipient), REWARD / 2);
    assertTrue(operation.executed());
  }

  function test_executeRevertsWhenOperationReverts() public {
    vm.prank(RELAYER);
    _executeCall(REWARD);

    vm.expectRevert("already executed");
    vm.prank(RELAYER);
    _executeCall(0);
  }

  function test_executePaysWhenPayoutCoversTheGasAtTheInclusionPrice() public {
    vm.txGasPrice(10);

    vm.prank(RELAYER);
    uint256 payout = _executeCall(0, REWARD / 10, 1e18);

    assertEq(payout, REWARD);
    assertEq(token.balanceOf(RELAYER), REWARD);
  }

  function test_executeRevertsWhenTheInclusionPriceRisesAboveThePayout() public {
    vm.txGasPrice(11);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.OperationExecutor__InsufficientPayout.selector, REWARD, REWARD * 11 / 10)
    );
    vm.prank(RELAYER);
    _executeCall(0, REWARD / 10, 1e18);
  }

  function test_executePaysWhenTheInclusionPriceFalls() public {
    vm.txGasPrice(1);

    vm.prank(RELAYER);
    uint256 payout = _executeCall(0, REWARD / 10, 1e18);

    assertEq(payout, REWARD);
  }

  function test_executeRoundsTheGasCostUp() public {
    vm.txGasPrice(10);

    vm.expectRevert(abi.encodeWithSelector(Errors.OperationExecutor__InsufficientPayout.selector, REWARD, REWARD + 1));
    vm.prank(RELAYER);
    _executeCall(0, REWARD / 10, 1e18 + 1);
  }

  function test_executeKeepsTheHigherMinPayout() public {
    vm.txGasPrice(1);

    vm.expectRevert(abi.encodeWithSelector(Errors.OperationExecutor__InsufficientPayout.selector, REWARD, REWARD + 1));
    vm.prank(RELAYER);
    _executeCall(REWARD + 1, REWARD / 10, 1e18);
  }

  function test_executeWithoutGasToCoverChecksOnlyMinPayout() public {
    vm.txGasPrice(1 ether);

    vm.prank(RELAYER);
    uint256 payout = _executeCall(REWARD, 0, 1e18);

    assertEq(payout, REWARD);
  }

  function test_executeRevertsOnNestedExecutionAndRollsBackOuterOperation() public {
    ReentrantOperation reentrantOperation = new ReentrantOperation(executor, IERC20(address(token)));

    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    vm.prank(RELAYER);
    executor.execute(
      address(reentrantOperation), abi.encodeCall(ReentrantOperation.run, ()), IERC20(address(token)), 0, 0, 0
    );

    assertFalse(reentrantOperation.executed());
    assertEq(token.balanceOf(RELAYER), 0);
    assertEq(token.balanceOf(address(executor)), 0);
  }
}
