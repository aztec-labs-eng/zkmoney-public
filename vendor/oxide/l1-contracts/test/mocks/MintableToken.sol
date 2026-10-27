// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MintableToken is ERC20 {
  uint8 internal immutable DECIMALS;

  constructor(string memory _name, string memory _symbol, uint8 _decimals) ERC20(_name, _symbol) {
    DECIMALS = _decimals;
  }

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }

  function decimals() public view override returns (uint8) {
    return DECIMALS;
  }
}
