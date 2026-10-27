// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@oz/utils/Address.sol";
import {Errors} from "@periphery/Errors.sol";

// solhint-disable-next-line oxide/no-comments
/**
 * @notice Base for the adapters that `MultiStepExecutor` steps call.
 */
abstract contract CoreAdapter {
  using SafeERC20 for IERC20;

  receive() external payable {}

  function erc20Transfer(IERC20 _token, uint256 _amount, address _recipient) external {
    _transferERC20(_token, _resolveERC20Amount(_token, _amount), _recipient);
  }

  function ethTransfer(uint256 _amount, address _recipient) external {
    _transferEth(_resolveEthAmount(_amount), _recipient);
  }

  function _requireRecipient(address _recipient) internal pure {
    require(_recipient != address(0), Errors.CoreAdapter__ZeroRecipient());
  }

  function _resolveERC20Amount(IERC20 _token, uint256 _amount) internal view returns (uint256) {
    return _amount == type(uint256).max ? _token.balanceOf(address(this)) : _amount;
  }

  function _resolveEthAmount(uint256 _amount) internal view returns (uint256) {
    return _amount == type(uint256).max ? address(this).balance : _amount;
  }

  function _transferERC20(IERC20 _token, uint256 _amount, address _recipient) internal {
    _requireRecipient(_recipient);
    _token.safeTransfer(_recipient, _amount);
  }

  function _transferEth(uint256 _amount, address _recipient) internal {
    _requireRecipient(_recipient);
    Address.sendValue(payable(_recipient), _amount);
  }
}
