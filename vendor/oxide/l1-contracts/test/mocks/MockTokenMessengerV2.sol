// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";

contract MockTokenMessengerV2 is ITokenMessengerV2 {
  struct Burn {
    uint256 amount;
    uint32 destinationDomain;
    bytes32 mintRecipient;
    address burnToken;
    bytes32 destinationCaller;
    uint256 maxFee;
    uint32 minFinalityThreshold;
    bytes hookData;
    address sender;
  }

  Burn internal $lastBurn;
  uint256 public burnCount;

  function lastBurn() external view returns (Burn memory) {
    return $lastBurn;
  }

  function depositForBurnWithHook(
    uint256 _amount,
    uint32 _destinationDomain,
    bytes32 _mintRecipient,
    address _burnToken,
    bytes32 _destinationCaller,
    uint256 _maxFee,
    uint32 _minFinalityThreshold,
    bytes calldata _hookData
  ) external {
    IERC20(_burnToken).transferFrom(msg.sender, address(this), _amount);
    burnCount++;
    $lastBurn = Burn({
      amount: _amount,
      destinationDomain: _destinationDomain,
      mintRecipient: _mintRecipient,
      burnToken: _burnToken,
      destinationCaller: _destinationCaller,
      maxFee: _maxFee,
      minFinalityThreshold: _minFinalityThreshold,
      hookData: _hookData,
      sender: msg.sender
    });
  }
}
