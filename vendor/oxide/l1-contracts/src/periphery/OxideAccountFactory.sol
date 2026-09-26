// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Errors} from "@periphery/Errors.sol";
import {OxideAccount} from "./OxideAccount.sol";
import {IOxideAccountFactory} from "./interfaces/IOxideAccountFactory.sol";

contract OxideAccountFactory is IOxideAccountFactory {
  address public immutable implementation;

  event AccountDeployed(address indexed bootstrap, address account);

  constructor() {
    implementation = address(new OxideAccount());
  }

  function deploy(address bootstrap) external override returns (address account) {
    if (bootstrap == address(0)) revert Errors.OxideAccountFactory__InvalidBootstrapOwner();
    account = predictAccountAddress(bootstrap);
    if (account.code.length > 0) {
      return account;
    }
    Clones.cloneDeterministicWithImmutableArgs(implementation, _args(bootstrap), bytes32(0));
    emit AccountDeployed(bootstrap, account);
  }

  function predictAccountAddress(address bootstrap) public view override returns (address) {
    return Clones.predictDeterministicAddressWithImmutableArgs(implementation, _args(bootstrap), bytes32(0));
  }

  function _args(address bootstrap) private pure returns (bytes memory) {
    return abi.encode(bootstrap);
  }
}
