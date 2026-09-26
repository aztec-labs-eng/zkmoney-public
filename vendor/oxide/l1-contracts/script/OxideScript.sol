// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Script} from "forge-std/Script.sol";

abstract contract OxideScript is Script {
  error OxideScript__MissingEnv(string name);

  function _envRaw(string memory _name) internal view virtual returns (bool set, string memory value) {
    if (!vm.envExists(_name)) return (false, "");
    value = vm.envString(_name);
    set = bytes(value).length > 0;
  }

  function _envOr(string memory _name, address _default) internal view returns (address) {
    (bool set, string memory value) = _envRaw(_name);
    return set ? vm.parseAddress(value) : _default;
  }

  function _envOr(string memory _name, uint256 _default) internal view returns (uint256) {
    (bool set, string memory value) = _envRaw(_name);
    return set ? vm.parseUint(value) : _default;
  }

  function _envOr(string memory _name, bool _default) internal view returns (bool) {
    (bool set, string memory value) = _envRaw(_name);
    return set ? vm.parseBool(value) : _default;
  }

  function _envOr(string memory _name, string memory _default) internal view returns (string memory) {
    (bool set, string memory value) = _envRaw(_name);
    return set ? value : _default;
  }

  function _envAddress(string memory _name) internal view returns (address) {
    return vm.parseAddress(_envRequired(_name));
  }

  function _envUint(string memory _name) internal view returns (uint256) {
    return vm.parseUint(_envRequired(_name));
  }

  function _envBytes32(string memory _name) internal view returns (bytes32) {
    return vm.parseBytes32(_envRequired(_name));
  }

  function _envRequired(string memory _name) private view returns (string memory value) {
    bool set;
    (set, value) = _envRaw(_name);
    if (!set) revert OxideScript__MissingEnv(_name);
  }
}
