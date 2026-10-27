// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SIPABase} from "./SIPABase.sol";
import {INameRegistry} from "./interfaces/INameRegistry.sol";
import {IRegistrationController} from "./interfaces/IRegistrationController.sol";
import {ThreePoolLib} from "./ThreePoolLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Errors} from "@periphery/Errors.sol";

contract RegistrationSIPA is SIPABase {
  INameRegistry public immutable NAME_REGISTRY;

  constructor(INameRegistry nameRegistry) {
    require(address(nameRegistry) != address(0), Errors.RegistrationSIPA__ZeroNameRegistry());
    NAME_REGISTRY = nameRegistry;
  }

  function INTENT() public pure override returns (Intent) {
    return Intent.Registration;
  }

  function _execute(address token, bytes calldata intentData, bytes calldata proofs)
    internal
    override
    returns (Routing memory)
  {
    address settledToken = ThreePoolLib.swapToDai(token);
    (, uint256 fee, address beneficiary, bytes32 recipientCommitment,) =
      abi.decode(intentData, (bytes, uint256, address, bytes32, bytes32));
    (,, uint128 beneficiaryFee,) = _args().table.rowFor(settledToken, INTENT());
    uint256 balance = IERC20(settledToken).balanceOf(address(this));
    require(balance >= beneficiaryFee, Errors.RegistrationSIPA__BalanceBelowBeneficiaryFee(balance, beneficiaryFee));
    IRegistrationController controller = IRegistrationController(NAME_REGISTRY.registrationController());
    controller.register(settledToken, balance - beneficiaryFee, intentData, proofs);
    return Routing({token: settledToken, feeRecipient: beneficiary, fee: fee, remainderRecipient: recipientCommitment});
  }
}
