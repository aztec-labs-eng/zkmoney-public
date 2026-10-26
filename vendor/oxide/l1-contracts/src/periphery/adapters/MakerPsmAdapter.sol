// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IMakerPsm} from "@periphery/interfaces/IMakerPsm.sol";
import {Errors} from "@periphery/Errors.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract MakerPsmAdapter is CoreAdapter {
  using SafeERC20 for IERC20;

  uint256 internal constant WAD = 1e18;

  function psmBuyGem(IMakerPsm _psm, uint256 _amountIn, uint256 _minOut, address _recipient) external {
    _requireRecipient(_recipient);
    IERC20 tokenIn = IERC20(_psm.dai());
    uint256 amountIn = _resolveERC20Amount(tokenIn, _amountIn);
    uint256 to18ConversionFactor = _psm.to18ConversionFactor();
    uint256 tout = _psm.tout();
    uint256 gemAmt = (amountIn * WAD) / (to18ConversionFactor * (WAD + tout));
    require(gemAmt >= _minOut, Errors.MakerPsmAdapter__InsufficientOutput(gemAmt, _minOut));

    tokenIn.forceApprove(address(_psm), amountIn);
    _psm.buyGem(_recipient, gemAmt);
  }
}
