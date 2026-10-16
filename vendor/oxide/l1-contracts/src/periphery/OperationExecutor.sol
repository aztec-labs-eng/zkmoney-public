// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Errors} from "@periphery/Errors.sol";

contract OperationExecutor is ReentrancyGuardTransient {
  using SafeERC20 for IERC20;

  function execute(
    address _target,
    bytes calldata _data,
    IERC20 _payoutToken,
    uint256 _minPayout,
    uint256 _gasToCover,
    uint256 _tokenWeiPerEth
  ) external nonReentrant returns (uint256 payout) {
    uint256 balanceBefore = _payoutToken.balanceOf(address(this));
    Address.functionCall(_target, _data);
    payout = _payoutToken.balanceOf(address(this)) - balanceBefore;

    uint256 gasCostWei = _gasToCover * tx.gasprice;
    uint256 gasCostInToken = Math.mulDiv(gasCostWei, _tokenWeiPerEth, 1e18, Math.Rounding.Ceil);
    // solhint-disable-next-line oxide/no-comments
    // A _minPayout above gasCostInToken sets a minimum profit for the caller.
    uint256 requiredPayout = Math.max(_minPayout, gasCostInToken);
    require(payout >= requiredPayout, Errors.OperationExecutor__InsufficientPayout(payout, requiredPayout));
    _payoutToken.safeTransfer(msg.sender, payout);
  }
}
