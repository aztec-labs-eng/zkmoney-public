// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SIPABase} from "./SIPABase.sol";
import {ThreePoolLib} from "./ThreePoolLib.sol";

contract DepositSIPA is SIPABase {
  function INTENT() public pure override returns (Intent) {
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
