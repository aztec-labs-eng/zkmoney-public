// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";

contract MockAcrossSpokePool is IAcrossSpokePool {
  struct Deposit {
    address depositor;
    address recipient;
    address inputToken;
    address outputToken;
    uint256 inputAmount;
    uint256 outputAmount;
    uint256 destinationChainId;
    address exclusiveRelayer;
    uint32 fillDeadlineOffset;
    uint32 exclusivityParameter;
    bytes message;
    address sender;
  }

  Deposit internal $lastDeposit;
  uint256 public depositCount;

  function lastDeposit() external view returns (Deposit memory) {
    return $lastDeposit;
  }

  function depositV3Now(
    address _depositor,
    address _recipient,
    address _inputToken,
    address _outputToken,
    uint256 _inputAmount,
    uint256 _outputAmount,
    uint256 _destinationChainId,
    address _exclusiveRelayer,
    uint32 _fillDeadlineOffset,
    uint32 _exclusivityParameter,
    bytes calldata _message
  ) external payable {
    IERC20(_inputToken).transferFrom(msg.sender, address(this), _inputAmount);
    depositCount++;
    $lastDeposit = Deposit({
      depositor: _depositor,
      recipient: _recipient,
      inputToken: _inputToken,
      outputToken: _outputToken,
      inputAmount: _inputAmount,
      outputAmount: _outputAmount,
      destinationChainId: _destinationChainId,
      exclusiveRelayer: _exclusiveRelayer,
      fillDeadlineOffset: _fillDeadlineOffset,
      exclusivityParameter: _exclusivityParameter,
      message: _message,
      sender: msg.sender
    });
  }
}
