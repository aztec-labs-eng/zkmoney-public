// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aztec Labs.
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ICurve3Pool} from "./interfaces/ICurve3Pool.sol";
import {Errors} from "@periphery/Errors.sol";

IERC20 constant DAI = IERC20(0x6B175474E89094C44Da98b954EedeAC495271d0F);
IERC20 constant USDC = IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
IERC20 constant USDT = IERC20(0xdAC17F958D2ee523a2206206994597C13D831ec7);

ICurve3Pool constant THREE_POOL = ICurve3Pool(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);

int128 constant POOL3_DAI_IDX = 0;
int128 constant POOL3_USDC_IDX = 1;
int128 constant POOL3_USDT_IDX = 2;

uint256 constant MAINNET_CHAIN_ID = 1;

library ThreePoolLib {
  using SafeERC20 for IERC20;

  uint256 internal constant BPS_DENOMINATOR = 10_000;
  uint256 internal constant SWAP_MAX_SLIPPAGE_BPS = 100;
  uint256 internal constant STABLE_TO_DAI_DECIMAL_SCALE = 1e12;

  function isSwapInput(address _token) internal pure returns (bool) {
    return _token == address(USDC) || _token == address(USDT);
  }

  function swapToDai(address _token) internal returns (address settledToken) {
    if (block.chainid != MAINNET_CHAIN_ID || !isSwapInput(_token)) {
      return _token;
    }

    uint256 sent = IERC20(_token).balanceOf(address(this));
    require(sent > 0, Errors.SIPA__EmptyBalance());

    int128 idxIn = _token == address(USDC) ? POOL3_USDC_IDX : POOL3_USDT_IDX;
    uint256 minDy = (sent * STABLE_TO_DAI_DECIMAL_SCALE * (BPS_DENOMINATOR - SWAP_MAX_SLIPPAGE_BPS)) / BPS_DENOMINATOR;
    IERC20(_token).forceApprove(address(THREE_POOL), sent);
    THREE_POOL.exchange(idxIn, POOL3_DAI_IDX, sent, minDy);
    return address(DAI);
  }

  function swapDaiTo(
    ICurve3Pool _pool,
    address _dai,
    int128 _idxOut,
    address _tokenOut,
    uint256 _amountIn,
    uint256 _maxSlippageBps
  ) internal returns (uint256 tokenOutBalance) {
    uint256 minDy = (_amountIn * (BPS_DENOMINATOR - _maxSlippageBps)) / BPS_DENOMINATOR / STABLE_TO_DAI_DECIMAL_SCALE;
    IERC20(_dai).forceApprove(address(_pool), _amountIn);
    _pool.exchange(POOL3_DAI_IDX, _idxOut, _amountIn, minDy);
    return IERC20(_tokenOut).balanceOf(address(this));
  }
}
