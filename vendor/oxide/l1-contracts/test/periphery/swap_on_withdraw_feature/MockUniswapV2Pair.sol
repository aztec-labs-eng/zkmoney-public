// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockUniswapV2Pair {
  address public immutable token0;
  address public immutable token1;

  uint112 internal $reserve0;
  uint112 internal $reserve1;
  uint32 internal $blockTimestampLast;

  uint256 public callCount;

  constructor(address _tokenA, address _tokenB) {
    (token0, token1) = _tokenA < _tokenB ? (_tokenA, _tokenB) : (_tokenB, _tokenA);
  }

  function getReserves() external view returns (uint112, uint112, uint32) {
    return ($reserve0, $reserve1, $blockTimestampLast);
  }

  function sync() external {
    _update();
  }

  function swap(uint256 _amount0Out, uint256 _amount1Out, address _to, bytes calldata) external {
    callCount++;
    require(_amount0Out > 0 || _amount1Out > 0, "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT");
    uint256 reserve0 = $reserve0;
    uint256 reserve1 = $reserve1;
    require(_amount0Out < reserve0 && _amount1Out < reserve1, "UniswapV2: INSUFFICIENT_LIQUIDITY");

    if (_amount0Out > 0) {
      IERC20(token0).transfer(_to, _amount0Out);
    }
    if (_amount1Out > 0) {
      IERC20(token1).transfer(_to, _amount1Out);
    }
    uint256 balance0 = IERC20(token0).balanceOf(address(this));
    uint256 balance1 = IERC20(token1).balanceOf(address(this));
    uint256 amount0In = balance0 > reserve0 - _amount0Out ? balance0 - (reserve0 - _amount0Out) : 0;
    uint256 amount1In = balance1 > reserve1 - _amount1Out ? balance1 - (reserve1 - _amount1Out) : 0;
    require(amount0In > 0 || amount1In > 0, "UniswapV2: INSUFFICIENT_INPUT_AMOUNT");
    uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
    uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
    require(balance0Adjusted * balance1Adjusted >= reserve0 * reserve1 * 1000 ** 2, "UniswapV2: K");
    _update();
  }

  function _update() private {
    $reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
    $reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    $blockTimestampLast = uint32(block.timestamp);
  }
}
