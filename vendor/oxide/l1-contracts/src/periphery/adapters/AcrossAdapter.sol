// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";

contract AcrossAdapter is CoreAdapter {
  using SafeERC20 for IERC20;

  // solhint-disable oxide/no-comments
  struct Deposit {
    IERC20 inputToken;
    uint256 amount;
    uint256 destinationChainId;
    address outputToken;
    // Decimals of outputToken on the destination chain, for example 18 for USDT on BNB.
    uint8 outputDecimals;
    address recipient;
    // Input token units that the Across relayer keeps, including the destination gas.
    uint256 fee;
    address depositor;
    // Seconds after the deposit until a relayer can no longer fill it.
    uint32 fillDeadlineOffset;
  }

  struct DepositWithMessage {
    IERC20 inputToken;
    uint256 amount;
    uint256 destinationChainId;
    address outputToken;
    // Decimals of outputToken on the destination chain, for example 18 for USDT on BNB.
    uint8 outputDecimals;
    address recipient;
    // Input token units that the Across relayer keeps, including the destination gas.
    uint256 fee;
    address depositor;
    // Seconds after the deposit until a relayer can no longer fill it.
    uint32 fillDeadlineOffset;
    bytes message;
  }
  // solhint-enable oxide/no-comments

  IAcrossSpokePool public immutable SPOKE_POOL;

  constructor(IAcrossSpokePool _spokePool) {
    SPOKE_POOL = _spokePool;
  }

  function acrossDeposit(Deposit calldata _deposit) external {
    _acrossDeposit(_deposit, "");
  }

  function acrossDepositWithMessage(DepositWithMessage calldata _depositWithMessage) external {
    _acrossDeposit(
      Deposit({
        inputToken: _depositWithMessage.inputToken,
        amount: _depositWithMessage.amount,
        destinationChainId: _depositWithMessage.destinationChainId,
        outputToken: _depositWithMessage.outputToken,
        outputDecimals: _depositWithMessage.outputDecimals,
        recipient: _depositWithMessage.recipient,
        fee: _depositWithMessage.fee,
        depositor: _depositWithMessage.depositor,
        fillDeadlineOffset: _depositWithMessage.fillDeadlineOffset
      }),
      _depositWithMessage.message
    );
  }

  function _scale(uint256 _amount, uint8 _fromDecimals, uint8 _toDecimals) private pure returns (uint256) {
    if (_toDecimals >= _fromDecimals) {
      return _amount * (10 ** (_toDecimals - _fromDecimals));
    }
    return _amount / (10 ** (_fromDecimals - _toDecimals));
  }

  function _acrossDeposit(Deposit memory _deposit, bytes memory _message) private {
    _requireRecipient(_deposit.depositor);
    _requireRecipient(_deposit.recipient);
    uint256 amount = _resolveERC20Amount(_deposit.inputToken, _deposit.amount);
    require(amount > _deposit.fee, Errors.AcrossAdapter__AmountNotAboveFee(amount, _deposit.fee));
    uint8 inputDecimals = IERC20Metadata(address(_deposit.inputToken)).decimals();
    uint256 outputAmount = _scale(amount - _deposit.fee, inputDecimals, _deposit.outputDecimals);

    _deposit.inputToken.forceApprove(address(SPOKE_POOL), amount);
    SPOKE_POOL.depositV3Now(
      _deposit.depositor,
      _deposit.recipient,
      address(_deposit.inputToken),
      _deposit.outputToken,
      amount,
      outputAmount,
      _deposit.destinationChainId,
      address(0),
      _deposit.fillDeadlineOffset,
      0,
      _message
    );
  }
}
