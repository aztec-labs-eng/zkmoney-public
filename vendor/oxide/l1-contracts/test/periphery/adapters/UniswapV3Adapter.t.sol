// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {Errors} from "@periphery/Errors.sol";
import {UniswapV3Adapter} from "@periphery/adapters/UniswapV3Adapter.sol";
import {MockUniversalRouter} from "@test/mocks/MockUniversalRouter.sol";

contract UniswapV3AdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT_IN = 1000e18;
  uint256 internal constant RATE = 4e14;
  uint24 internal constant POOL_FEE = 500;
  uint256 internal constant AMOUNT_OUT = 0.1e18;
  uint256 internal constant FIXED_AMOUNT_IN = 300e18;
  uint256 internal constant FIXED_MAX_IN = 400e18;

  TestERC20 internal tokenIn;
  TestERC20 internal tokenOut;
  MockUniversalRouter internal router;
  UniswapV3Adapter internal adapter;
  address internal recipient = makeAddr("recipient");
  address internal leftoverRecipient = makeAddr("leftoverRecipient");

  function setUp() external {
    tokenIn = new TestERC20("In", "IN", address(this));
    tokenOut = new TestERC20("Out", "OUT", address(this));
    router = new MockUniversalRouter();
    router.setRate(address(tokenOut), RATE);
    tokenOut.mint(address(router), 1_000_000e18);
    adapter = new UniswapV3Adapter(IUniversalRouter(address(router)));
  }

  function test_ExactInFundsTheRouterAndSendsOneSwapCommand() external {
    tokenIn.mint(address(adapter), AMOUNT_IN);
    uint256 minOut = (AMOUNT_IN * RATE) / 1e18;

    adapter.uniswapV3ExactIn(_path(), MAX, minOut, recipient);

    assertEq(tokenIn.balanceOf(address(router)), AMOUNT_IN);
    assertEq(tokenIn.balanceOf(address(adapter)), 0);
    assertEq(router.lastCommands(), abi.encodePacked(uint8(Commands.V3_SWAP_EXACT_IN)));
    assertEq(router.lastDeadline(), block.timestamp);
    assertEq(router.inputCount(), 1);
    (address routerRecipient, uint256 amountIn, uint256 amountOutMinimum, bytes memory path, bool payerIsUser) =
      abi.decode(router.inputAt(0), (address, uint256, uint256, bytes, bool));
    assertEq(routerRecipient, recipient);
    assertEq(amountIn, AMOUNT_IN);
    assertEq(amountOutMinimum, minOut);
    assertEq(path, _path());
    assertFalse(payerIsUser);
  }

  function test_AFixedAmountLeavesTheRestInTheAdapter() external {
    tokenIn.mint(address(adapter), AMOUNT_IN);

    adapter.uniswapV3ExactIn(_path(), FIXED_AMOUNT_IN, 0, recipient);

    assertEq(tokenIn.balanceOf(address(router)), FIXED_AMOUNT_IN);
    assertEq(tokenIn.balanceOf(address(adapter)), AMOUNT_IN - FIXED_AMOUNT_IN);
  }

  function test_AZeroRecipientReverts() external {
    tokenIn.mint(address(adapter), AMOUNT_IN);

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.uniswapV3ExactIn(_path(), MAX, 0, address(0));

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.uniswapV3ExactOut(_exactOutPath(), AMOUNT_OUT, MAX, address(0), leftoverRecipient);

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.uniswapV3ExactOut(_exactOutPath(), AMOUNT_OUT, MAX, recipient, address(0));
  }

  function test_ExactOutFundsTheRouterAndSendsASwapAndASweepToTheLeftoverRecipient() external {
    tokenIn.mint(address(adapter), AMOUNT_IN);

    vm.expectEmit(address(tokenIn));
    emit IERC20.Transfer(address(adapter), address(router), AMOUNT_IN);
    adapter.uniswapV3ExactOut(_exactOutPath(), AMOUNT_OUT, MAX, recipient, leftoverRecipient);

    assertEq(router.lastCommands(), abi.encodePacked(uint8(Commands.V3_SWAP_EXACT_OUT), uint8(Commands.SWEEP)));
    assertEq(router.lastDeadline(), block.timestamp);
    assertEq(router.inputCount(), 2);
    (address routerRecipient, uint256 amountOut, uint256 amountInMaximum, bytes memory path, bool payerIsUser) =
      abi.decode(router.inputAt(0), (address, uint256, uint256, bytes, bool));
    assertEq(routerRecipient, recipient);
    assertEq(amountOut, AMOUNT_OUT);
    assertEq(amountInMaximum, AMOUNT_IN);
    assertEq(path, _exactOutPath());
    assertFalse(payerIsUser);
    (address token, address sweepRecipient, uint256 amountMinimum) =
      abi.decode(router.inputAt(1), (address, address, uint256));
    assertEq(token, address(tokenIn));
    assertEq(sweepRecipient, leftoverRecipient);
    assertEq(amountMinimum, 0);
  }

  function test_ExactOutWithAFixedMaxInFundsTheRouterWithThatAmount() external {
    tokenIn.mint(address(adapter), AMOUNT_IN);

    vm.expectEmit(address(tokenIn));
    emit IERC20.Transfer(address(adapter), address(router), FIXED_MAX_IN);
    adapter.uniswapV3ExactOut(_exactOutPath(), AMOUNT_OUT, FIXED_MAX_IN, recipient, leftoverRecipient);

    (,, uint256 amountInMaximum,,) = abi.decode(router.inputAt(0), (address, uint256, uint256, bytes, bool));
    assertEq(amountInMaximum, FIXED_MAX_IN);
  }

  function test_ExactOutTakesTheTokenInFromTheEndOfAMultiHopPath() external {
    TestERC20 middle = new TestERC20("Mid", "MID", address(this));
    tokenIn.mint(address(adapter), AMOUNT_IN);
    bytes memory path = abi.encodePacked(address(tokenOut), POOL_FEE, address(middle), POOL_FEE, address(tokenIn));

    adapter.uniswapV3ExactOut(path, AMOUNT_OUT, MAX, recipient, leftoverRecipient);

    (address sweptToken,,) = abi.decode(router.inputAt(1), (address, address, uint256));
    assertEq(sweptToken, address(tokenIn));
  }

  function _path() internal view returns (bytes memory) {
    return abi.encodePacked(address(tokenIn), POOL_FEE, address(tokenOut));
  }

  function _exactOutPath() internal view returns (bytes memory) {
    return abi.encodePacked(address(tokenOut), POOL_FEE, address(tokenIn));
  }
}
