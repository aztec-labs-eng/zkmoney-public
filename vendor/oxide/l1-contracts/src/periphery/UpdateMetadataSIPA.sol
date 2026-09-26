// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SIPABase} from "./SIPABase.sol";
import {INameRegistry} from "./interfaces/INameRegistry.sol";
import {IAccountMetadataController, MetadataUpdateIntent} from "./interfaces/IAccountMetadataController.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {ThreePoolLib} from "./ThreePoolLib.sol";
import {Errors} from "./Errors.sol";

uint256 constant METADATA_UPDATE_SWEEP_FEE = 5e17;

contract UpdateMetadataSIPA is SIPABase {
  INameRegistry public immutable NAME_REGISTRY;

  constructor(IOxidePortal portal_, INameRegistry nameRegistry, uint256 fee) SIPABase(portal_, fee) {
    require(address(nameRegistry) != address(0), Errors.RegistrationSIPA__ZeroNameRegistry());
    NAME_REGISTRY = nameRegistry;
  }

  function INTENT() external pure override returns (Intent) {
    return Intent.UpdateMetadata;
  }

  function _execute(address token, bytes calldata intentData, bytes calldata proofs)
    internal
    override
    returns (Routing memory)
  {
    require(!_args().resweepable, Errors.MetadataUpdate__Resweepable());
    address settledToken = ThreePoolLib.swapToDai(token);
    MetadataUpdateIntent memory intent = abi.decode(intentData, (MetadataUpdateIntent));
    require(intent.rollupVersion == PORTAL.ROLLUP_VERSION(), Errors.SIPA__RollupVersionMismatch());
    IAccountMetadataController(NAME_REGISTRY.registrationController())
      .updateUser(intentData, abi.decode(proofs, (bytes)));
    return Routing(settledToken, address(0), 0, intent.recipientCommitment);
  }
}
