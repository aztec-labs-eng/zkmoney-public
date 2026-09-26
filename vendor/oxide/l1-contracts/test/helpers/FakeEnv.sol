// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {OxideScript} from "../../script/OxideScript.sol";

abstract contract FakeEnv is OxideScript {
  mapping(string name => string value) private values;

  function withEnv(string memory _name, string memory _value) external {
    values[_name] = _value;
  }

  function withoutEnv(string memory _name) external {
    delete values[_name];
  }

  function _envRaw(string memory _name) internal view virtual override returns (bool set, string memory value) {
    value = values[_name];
    set = bytes(value).length > 0;
  }
}
