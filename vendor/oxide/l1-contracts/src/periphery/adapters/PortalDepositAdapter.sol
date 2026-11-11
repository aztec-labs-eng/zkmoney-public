// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract PortalDepositAdapter is CoreAdapter {
  using SafeERC20 for IERC20;

  function portalDeposit(IOxidePortal _portal, uint256 _amount, bytes32 _recipientCommitment) external {
    IERC20 token = _portal.UNDERLYING();
    uint256 amount = _resolveERC20Amount(token, _amount);
    token.forceApprove(address(_portal), amount);
    _portal.deposit(_recipientCommitment, amount);
  }
}
