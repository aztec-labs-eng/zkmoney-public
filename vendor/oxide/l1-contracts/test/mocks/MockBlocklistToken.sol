// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {MintableToken} from "@test/mocks/MintableToken.sol";

contract MockBlocklistToken is MintableToken {
  mapping(address account => bool blocked) public isBlocked;

  constructor(string memory _name, string memory _symbol, uint8 _decimals) MintableToken(_name, _symbol, _decimals) {}

  function setBlocked(address _account, bool _blocked) external {
    isBlocked[_account] = _blocked;
  }

  function _update(address _from, address _to, uint256 _value) internal override {
    require(!isBlocked[_from] && !isBlocked[_to], "MockBlocklistToken: blocked");
    super._update(_from, _to, _value);
  }
}
