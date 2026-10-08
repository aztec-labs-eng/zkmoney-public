// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Ownable} from "@oz/access/Ownable.sol";
import {IDaiUsds} from "@periphery/experiments/sky/interfaces/IDaiUsds.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";

contract MockDaiUsds is IDaiUsds, Ownable {
  TestERC20 public immutable DAI;
  TestERC20 public immutable USDS;

  bool public broken;

  error MockDaiUsds__Paused();

  constructor(TestERC20 _dai, TestERC20 _usds, address _owner) Ownable(_owner) {
    DAI = _dai;
    USDS = _usds;
  }

  function setBroken(bool _broken) external onlyOwner {
    broken = _broken;
  }

  function daiToUsds(address _usr, uint256 _wad) external override(IDaiUsds) {
    require(!broken, MockDaiUsds__Paused());
    DAI.transferFrom(msg.sender, address(this), _wad);
    USDS.mint(_usr, _wad);
  }

  function usdsToDai(address _usr, uint256 _wad) external override(IDaiUsds) {
    require(!broken, MockDaiUsds__Paused());
    USDS.transferFrom(msg.sender, address(this), _wad);
    DAI.mint(_usr, _wad);
  }
}
