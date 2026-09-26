// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {UniversalRouterLib} from "@periphery/fpc_funder/UniversalRouterLib.sol";

contract UniversalRouterLibTest is Test {
  address internal constant CURRENCY_OUT = address(0x2222);
  uint24 internal constant POOL_FEE = 2500;
  int24 internal constant POOL_TICK_SPACING = 25;

  function test_V3InputCarriesTheMinimumOutput() external pure {
    bytes memory input = UniversalRouterLib.v3SwapExactInInput(address(0xAAAA), 5e18, 7e6, hex"010203");
    (address recipient, uint256 amountIn, uint256 amountOutMinimum, bytes memory path, bool payerIsUser) =
      abi.decode(input, (address, uint256, uint256, bytes, bool));
    assertEq(recipient, address(0xAAAA));
    assertEq(amountIn, 5e18);
    assertEq(amountOutMinimum, 7e6);
    assertEq(path, hex"010203");
    assertFalse(payerIsUser);
  }

  function test_UnwrapInputCarriesTheMinimum() external pure {
    (address recipient, uint256 amountMinimum) =
      abi.decode(UniversalRouterLib.unwrapWethInput(address(0xBBBB), 3e18), (address, uint256));
    assertEq(recipient, address(0xBBBB));
    assertEq(amountMinimum, 3e18);
  }

  function test_V4InputCarriesTheMinimumOnSwapAndTake() external pure {
    bytes memory input =
      UniversalRouterLib.v4SwapAllInput(address(0x1111), CURRENCY_OUT, 9e18, POOL_FEE, POOL_TICK_SPACING, address(0));
    (, bytes[] memory params) = abi.decode(input, (bytes, bytes[]));
    IV4Router.ExactInputSingleParams memory swapParams = abi.decode(params[1], (IV4Router.ExactInputSingleParams));
    (address takeCurrency, uint256 takeMinimum) = abi.decode(params[2], (address, uint256));
    assertEq(swapParams.amountOutMinimum, 9e18);
    assertEq(takeCurrency, CURRENCY_OUT);
    assertEq(takeMinimum, 9e18);
  }

  function test_GivenCurrencyInBelowOut_ThenKeyKeepsOrder() external pure {
    _assertOrdering(address(0x1111), true);
  }

  function test_GivenCurrencyInAboveOut_ThenKeyFlipsOrder() external pure {
    _assertOrdering(address(0x3333), false);
  }

  function _assertOrdering(address _currencyIn, bool _zeroForOne) internal pure {
    bytes memory input =
      UniversalRouterLib.v4SwapAllInput(_currencyIn, CURRENCY_OUT, 0, POOL_FEE, POOL_TICK_SPACING, address(0));
    (, bytes[] memory params) = abi.decode(input, (bytes, bytes[]));
    IV4Router.ExactInputSingleParams memory swapParams = abi.decode(params[1], (IV4Router.ExactInputSingleParams));

    assertEq(Currency.unwrap(swapParams.poolKey.currency0), _zeroForOne ? _currencyIn : CURRENCY_OUT);
    assertEq(Currency.unwrap(swapParams.poolKey.currency1), _zeroForOne ? CURRENCY_OUT : _currencyIn);
    assertEq(swapParams.zeroForOne, _zeroForOne);
  }
}
