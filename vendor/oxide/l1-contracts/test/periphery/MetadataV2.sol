// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {INamePortal} from "@periphery/interfaces/INamePortal.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {MetadataUpdateIntent} from "@periphery/interfaces/IAccountMetadataController.sol";
import {Errors} from "@periphery/Errors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MetadataV2Registry is AccountMetadataRegistry {
  mapping(address => bytes32) public migrationTags;

  constructor(INameRegistry nameRegistry) AccountMetadataRegistry(nameRegistry) {}

  function setTaggedRecord(address user, UserRecord calldata record, bytes32 migrationTag) external {
    _checkMsgSenderAuthorizedToUpdate(user);
    _isValidPublicKey(record.publicKey);
    userRecords[user] = record;
    migrationTags[user] = migrationTag;
    emit UserRecordUpdated(user, record);
  }
}

contract MetadataV2Controller is RegistrationController {
  constructor(
    INameRegistry nameRegistry,
    SIPAFactory sipaFactory,
    IOxideAccountFactory accountFactory,
    INamePortal namePortal,
    IERC20 feeToken,
    uint256 registrationMin,
    uint256 registrationFee,
    address initialBeneficiary
  )
    RegistrationController(
      nameRegistry,
      sipaFactory,
      accountFactory,
      namePortal,
      feeToken,
      registrationMin,
      registrationFee,
      initialBeneficiary
    )
  {}

  function metadataStateHash(address owner) public view override returns (bytes32) {
    MetadataV2Registry registry = MetadataV2Registry(NAME_REGISTRY.accountMetadataRegistry());
    return registry.hasUserRecord(owner)
      ? keccak256(abi.encode(registry.getUserRecord(owner), registry.migrationTags(owner)))
      : bytes32(0);
  }

  function _writeMetadata(MetadataUpdateIntent memory intent) internal override {
    (AccountMetadataRegistry.UserRecord memory record, bytes32 tag) =
      abi.decode(intent.metadata, (AccountMetadataRegistry.UserRecord, bytes32));
    require(record.rollupVersion == intent.rollupVersion, Errors.SIPA__RollupVersionMismatch());
    MetadataV2Registry(intent.metadataRegistry).setTaggedRecord(intent.owner, record, tag);
  }
}
