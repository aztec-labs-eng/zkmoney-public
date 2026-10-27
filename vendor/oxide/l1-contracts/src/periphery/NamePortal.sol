// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {INamePortal} from "./interfaces/INamePortal.sol";
import {INameRegistry} from "./interfaces/INameRegistry.sol";
import {IOxideAccountFactory} from "./interfaces/IOxideAccountFactory.sol";
import {OxideAccount} from "./OxideAccount.sol";
import {Errors} from "@periphery/Errors.sol";

contract NamePortal is INamePortal {
  event NameNotified(
    address indexed user,
    bytes32 indexed nameHash,
    bytes32 indexed l2Recipient,
    uint256 rollupVersion,
    bytes32 key,
    uint256 index
  );

  INameRegistry public immutable NAME_REGISTRY;
  IRegistry public immutable AZTEC_REGISTRY;
  IOxideAccountFactory public immutable ACCOUNT_FACTORY;

  constructor(INameRegistry nameRegistry, IRegistry aztecRegistry, IOxideAccountFactory accountFactory) {
    require(address(nameRegistry) != address(0), Errors.NamePortal__ZeroNameRegistry());
    require(address(aztecRegistry) != address(0), Errors.NamePortal__ZeroAztecRegistry());
    require(address(accountFactory) != address(0), Errors.NamePortal__ZeroAccountFactory());
    NAME_REGISTRY = nameRegistry;
    AZTEC_REGISTRY = aztecRegistry;
    ACCOUNT_FACTORY = accountFactory;
  }

  function notify(address user, bytes32 l2Recipient, uint256 rollupVersion)
    external
    override
    returns (bytes32 key, uint256 index)
  {
    require(l2Recipient != bytes32(0), Errors.NamePortal__ZeroRecipient());
    bytes32 nameHash = NAME_REGISTRY.nameOf(user);
    require(nameHash != bytes32(0), Errors.NamePortal__NameNotFound(user));
    address bootstrap = OxideAccount(payable(user)).bootstrapOwner();
    require(ACCOUNT_FACTORY.predictAccountAddress(bootstrap) == user, Errors.NamePortal__NotFactoryAccount(user));

    IInbox inbox = IRollup(address(AZTEC_REGISTRY.getRollup(rollupVersion))).getInbox();
    bytes32 contentHash = Hash.sha256ToField(abi.encodePacked(bootstrap, nameHash));
    (key, index) = inbox.sendL2Message(
      DataStructures.L2Actor({actor: l2Recipient, version: rollupVersion}),
      contentHash,
      OxideConstants.PORTAL_CONSTANT_SECRET_HASH
    );

    emit NameNotified(user, nameHash, l2Recipient, rollupVersion, key, index);
  }
}
