// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IDaiUsds} from "@periphery/interfaces/IDaiUsds.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract SkyConverterAdapter is CoreAdapter {
  using SafeERC20 for IERC20;

  IDaiUsds public immutable CONVERTER;
  IERC20 public immutable DAI;
  IERC20 public immutable USDS;

  constructor(IDaiUsds _converter) {
    CONVERTER = _converter;
    DAI = IERC20(_converter.dai());
    USDS = IERC20(_converter.usds());
  }

  function daiToUsds(uint256 _amount, address _recipient) external {
    _requireRecipient(_recipient);
    uint256 amount = _resolveERC20Amount(DAI, _amount);
    DAI.forceApprove(address(CONVERTER), amount);
    CONVERTER.daiToUsds(_recipient, amount);
  }

  function usdsToDai(uint256 _amount, address _recipient) external {
    _requireRecipient(_recipient);
    uint256 amount = _resolveERC20Amount(USDS, _amount);
    USDS.forceApprove(address(CONVERTER), amount);
    CONVERTER.usdsToDai(_recipient, amount);
  }
}
