// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {NameRegistry} from "@periphery/NameRegistry.sol";

function deployTestNameRegistry(address owner) returns (NameRegistry) {
  return new NameRegistry(owner, owner);
}
