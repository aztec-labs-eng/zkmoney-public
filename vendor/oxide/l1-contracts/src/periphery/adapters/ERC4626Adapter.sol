// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@oz/interfaces/IERC4626.sol";
import {Errors} from "@periphery/Errors.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract ERC4626Adapter is CoreAdapter {
  using SafeERC20 for IERC20;

  function erc4626Deposit(IERC4626 _vault, uint256 _assets, uint256 _minShares, address _recipient) external {
    _requireRecipient(_recipient);
    IERC20 asset = IERC20(_vault.asset());
    uint256 assets = _resolveERC20Amount(asset, _assets);
    asset.forceApprove(address(_vault), assets);
    uint256 shares = _vault.deposit(assets, _recipient);
    require(shares >= _minShares, Errors.ERC4626Adapter__InsufficientOutput(shares, _minShares));
  }

  function erc4626Redeem(IERC4626 _vault, uint256 _shares, uint256 _minAssets, address _recipient) external {
    _requireRecipient(_recipient);
    uint256 shares = _resolveERC20Amount(IERC20(address(_vault)), _shares);
    uint256 assets = _vault.redeem(shares, _recipient, address(this));
    require(assets >= _minAssets, Errors.ERC4626Adapter__InsufficientOutput(assets, _minAssets));
  }
}
