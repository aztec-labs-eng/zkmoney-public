// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@oz/utils/Address.sol";
import {Errors} from "@periphery/Errors.sol";
import {MultiStepExecutor} from "@periphery/MultiStepExecutor.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";
import {ILifiInputSettlerEscrow, MandateOutput, StandardOrder} from "@periphery/interfaces/ILifiInputSettlerEscrow.sol";
import {ILifiOutputCallback} from "@periphery/interfaces/ILifiOutputCallback.sol";

contract LifiIntentAdapter is CoreAdapter, ILifiOutputCallback {
  using SafeERC20 for IERC20;

  // solhint-disable oxide/no-comments
  struct Open {
    IERC20 token;
    uint256 amount;
    uint256 destinationChainId;
    ILifiInputSettlerEscrow inputSettler;
    address inputOracle;
    // The oracle on the destination chain that proves the fill to inputOracle.
    bytes32 outputOracle;
    // The settler on the destination chain that the solver fills through.
    bytes32 outputSettler;
    bytes32 outputToken;
    bytes32 recipient;
    uint256 minOutput;
    address refundRecipient;
    uint256 nonce;
    // Seconds after the order opens until a solver can no longer fill it.
    uint32 fillWindow;
    // Seconds after the order opens until anyone can refund it to refundRecipient.
    uint32 expiryWindow;
    // The OIF order type data, for example a Dutch auction. Empty for a limit order.
    bytes context;
  }

  struct OpenWithHook {
    IERC20 token;
    uint256 amount;
    uint256 destinationChainId;
    ILifiInputSettlerEscrow inputSettler;
    address inputOracle;
    // The oracle on the destination chain that proves the fill to inputOracle.
    bytes32 outputOracle;
    // The settler on the destination chain that the solver fills through.
    bytes32 outputSettler;
    bytes32 outputToken;
    bytes32 recipient;
    uint256 minOutput;
    address refundRecipient;
    uint256 nonce;
    // Seconds after the order opens until a solver can no longer fill it.
    uint32 fillWindow;
    // Seconds after the order opens until anyone can refund it to refundRecipient.
    uint32 expiryWindow;
    // The OIF order type data, for example a Dutch auction. Empty for a limit order.
    bytes context;
    bytes callbackData;
  }
  // solhint-enable oxide/no-comments

  event HookFailed(bytes reason);

  function lifiOpen(Open calldata _open) external {
    _openOrder(_open, "");
  }

  function lifiOpenWithHook(OpenWithHook calldata _openWithHook) external {
    _openOrder(
      Open({
        token: _openWithHook.token,
        amount: _openWithHook.amount,
        destinationChainId: _openWithHook.destinationChainId,
        inputSettler: _openWithHook.inputSettler,
        inputOracle: _openWithHook.inputOracle,
        outputOracle: _openWithHook.outputOracle,
        outputSettler: _openWithHook.outputSettler,
        outputToken: _openWithHook.outputToken,
        recipient: _openWithHook.recipient,
        minOutput: _openWithHook.minOutput,
        refundRecipient: _openWithHook.refundRecipient,
        nonce: _openWithHook.nonce,
        fillWindow: _openWithHook.fillWindow,
        expiryWindow: _openWithHook.expiryWindow,
        context: _openWithHook.context
      }),
      _openWithHook.callbackData
    );
  }

  // solhint-disable-next-line oxide/no-comments
  /**
   * @notice LI.FI's output settler calls this when it fills an order with a hook.
   * @dev Runs the steps in `_executionData`. If they revert, it sends the output to the fallback recipient.
   * @dev Anyone can call it. This is safe because the adapter holds funds only during a transaction.
   */
  function outputFilled(bytes32 _token, uint256 _amount, bytes calldata _executionData) external {
    (address target, address fallbackRecipient, MultiStepExecutor.Step[] memory steps) =
      abi.decode(_executionData, (address, address, MultiStepExecutor.Step[]));
    _requireRecipient(fallbackRecipient);
    address token = address(uint160(uint256(_token)));
    try this.lifiRunHook(token, _amount, target, steps) {}
    catch (bytes memory reason) {
      emit HookFailed(reason);
      _transfer(token, _amount, fallbackRecipient);
    }
  }

  function lifiRunHook(address _token, uint256 _amount, address _target, MultiStepExecutor.Step[] calldata _steps)
    external
  {
    require(msg.sender == address(this), Errors.LifiIntentAdapter__NotSelf());
    _transfer(_token, _amount, _target);
    for (uint256 i = 0; i < _steps.length; i++) {
      Address.functionCall(_steps[i].target, _steps[i].data);
    }
  }

  function _openOrder(Open memory _open, bytes memory _callbackData) private {
    _requireRecipient(_open.refundRecipient);
    _requireRecipient(_open.recipient);
    IERC20 token = _open.token;
    uint256 amount = _resolveERC20Amount(token, _open.amount);

    uint256[2][] memory inputs = new uint256[2][](1);
    inputs[0] = [uint256(uint160(address(token))), amount];
    MandateOutput[] memory outputs = new MandateOutput[](1);
    outputs[0] = MandateOutput({
      oracle: _open.outputOracle,
      settler: _open.outputSettler,
      chainId: _open.destinationChainId,
      token: _open.outputToken,
      amount: _open.minOutput,
      recipient: _open.recipient,
      callbackData: _callbackData,
      context: _open.context
    });
    StandardOrder memory order = StandardOrder({
      user: _open.refundRecipient,
      nonce: _open.nonce,
      originChainId: block.chainid,
      expires: uint32(block.timestamp) + _open.expiryWindow,
      fillDeadline: uint32(block.timestamp) + _open.fillWindow,
      inputOracle: _open.inputOracle,
      inputs: inputs,
      outputs: outputs
    });

    token.forceApprove(address(_open.inputSettler), amount);
    _open.inputSettler.open(order);
  }

  function _transfer(address _token, uint256 _amount, address _recipient) private {
    if (_token == address(0)) {
      _transferEth(_amount, _recipient);
    } else {
      _transferERC20(IERC20(_token), _amount, _recipient);
    }
  }
}
