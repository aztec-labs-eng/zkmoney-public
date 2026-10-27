// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {Errors} from "@periphery/Errors.sol";

contract OperationExecutor is IOperationExecutor, ReentrancyGuardTransient {
  using SafeERC20 for IERC20;

  bool internal transient $direct;
  bool internal transient $startedEmpty;
  IERC20 internal transient $payoutToken;
  uint256 internal transient $headGas;

  function execute(
    address _target,
    bytes calldata _data,
    IERC20 _payoutToken,
    uint256 _minPayout,
    uint256 _gasToCover,
    uint256 _tokenWeiPerEth
  ) external nonReentrant returns (uint256 payout) {
    uint256 startGas = gasleft();
    uint256 gasCostWei = _gasToCover * tx.gasprice;
    uint256 gasCostInToken = Math.mulDiv(gasCostWei, _tokenWeiPerEth, 1e18, Math.Rounding.Ceil);
    // solhint-disable-next-line oxide/no-comments
    // A _minPayout above gasCostInToken sets a minimum profit for the caller.
    uint256 requiredPayout = Math.max(_minPayout, gasCostInToken);
    payout = _execute(startGas, _target, _data, _payoutToken, requiredPayout);
  }

  function executionContext() external view override(IOperationExecutor) returns (ExecutionContext memory) {
    return
      ExecutionContext({direct: $direct, startedEmpty: $startedEmpty, payoutToken: $payoutToken, headGas: $headGas});
  }

  function _execute(uint256 _startGas, address _target, bytes calldata _data, IERC20 _payoutToken, uint256 _minPayout)
    internal
    returns (uint256 payout)
  {
    uint256 balanceBefore = _payoutToken.balanceOf(address(this));
    $direct = msg.sender == tx.origin && msg.sender.code.length == 0;
    $startedEmpty = balanceBefore == 0;
    $payoutToken = _payoutToken;
    bytes memory data = _data;
    $headGas = _startGas - gasleft();
    Address.functionCall(_target, data);

    payout = _payoutToken.balanceOf(address(this)) - balanceBefore;
    require(payout >= _minPayout, Errors.OperationExecutor__InsufficientPayout(payout, _minPayout));
    _payoutToken.safeTransfer(msg.sender, payout);
  }
}
