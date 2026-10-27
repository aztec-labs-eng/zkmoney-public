// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract CurveAdapter is CoreAdapter {
  using SafeERC20 for IERC20;

  function curveExchange(
    ICurve3Pool _pool,
    int128 _i,
    int128 _j,
    uint256 _amountIn,
    uint256 _minOut,
    address _recipient
  ) external {
    IERC20 tokenIn = IERC20(_pool.coins(uint256(int256(_i))));
    IERC20 tokenOut = IERC20(_pool.coins(uint256(int256(_j))));
    uint256 amountIn = _resolveERC20Amount(tokenIn, _amountIn);

    tokenIn.forceApprove(address(_pool), amountIn);
    _pool.exchange(_i, _j, amountIn, _minOut);
    _transferERC20(tokenOut, tokenOut.balanceOf(address(this)), _recipient);
  }
}
