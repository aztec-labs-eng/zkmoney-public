// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";

abstract contract EscrowFactoryBase {
  IERC20 public immutable DAI;
  address public immutable IMPLEMENTATION;

  event EscrowExecuted(address indexed escrow, address tipRecipient);

  constructor(IERC20 _dai, address _implementation) {
    DAI = _dai;
    IMPLEMENTATION = _implementation;
  }

  function _deployAndExecute(bytes memory _encodedArgs, uint256 _relayerTip) internal returns (address escrow) {
    escrow = _predictEscrowAddress(_encodedArgs);

    uint256 balance = DAI.balanceOf(escrow);
    if (balance <= _relayerTip) {
      return escrow;
    }

    _deploy(_encodedArgs);
    EscrowBase(escrow).execute(msg.sender);
    emit EscrowExecuted(escrow, msg.sender);
  }

  function _deploy(bytes memory _encodedArgs) internal returns (address escrow) {
    escrow = _predictEscrowAddress(_encodedArgs);
    if (escrow.code.length == 0) {
      Clones.cloneDeterministicWithImmutableArgs(IMPLEMENTATION, _encodedArgs, bytes32(0));
    }
  }

  function _predictEscrowAddress(bytes memory _encodedArgs) internal view returns (address) {
    return Clones.predictDeterministicAddressWithImmutableArgs(IMPLEMENTATION, _encodedArgs, bytes32(0));
  }
}
