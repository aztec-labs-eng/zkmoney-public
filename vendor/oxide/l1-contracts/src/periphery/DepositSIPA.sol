// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SIPABase} from "./SIPABase.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {ThreePoolLib} from "./ThreePoolLib.sol";

uint256 constant DEPOSIT_FEE = 25e16;

contract DepositSIPA is SIPABase {
  constructor(IOxidePortal portal_, uint256 fee) SIPABase(portal_, fee) {}

  function INTENT() external pure override returns (Intent) {
    return Intent.Deposit;
  }

  function _execute(address token, bytes calldata intentData, bytes calldata)
    internal
    override
    returns (Routing memory)
  {
    address settledToken = ThreePoolLib.swapToDai(token);
    bytes32 recipientCommitment = abi.decode(intentData, (bytes32));
    return Routing({token: settledToken, feeRecipient: address(0), fee: 0, remainderRecipient: recipientCommitment});
  }
}
