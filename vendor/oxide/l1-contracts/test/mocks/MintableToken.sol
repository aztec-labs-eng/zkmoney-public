// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

contract MintableToken {
  mapping(address account => uint256 balance) public balanceOf;
  mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

  function mint(address _to, uint256 _amount) external {
    balanceOf[_to] += _amount;
  }

  function approve(address _spender, uint256 _amount) external returns (bool) {
    allowance[msg.sender][_spender] = _amount;
    return true;
  }

  function transfer(address _to, uint256 _amount) external returns (bool) {
    balanceOf[msg.sender] -= _amount;
    balanceOf[_to] += _amount;
    return true;
  }

  function transferFrom(address _from, address _to, uint256 _amount) external returns (bool) {
    allowance[_from][msg.sender] -= _amount;
    balanceOf[_from] -= _amount;
    balanceOf[_to] += _amount;
    return true;
  }
}
