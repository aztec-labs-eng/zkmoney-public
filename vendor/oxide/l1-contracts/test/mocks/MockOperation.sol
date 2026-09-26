// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockOperation {
  IERC20 internal immutable TOKEN;
  uint256 internal immutable REWARD;
  bool public executed;

  constructor(IERC20 _token, uint256 _reward) {
    TOKEN = _token;
    REWARD = _reward;
  }

  function run() external {
    require(!executed, "already executed");
    executed = true;
    TOKEN.transfer(msg.sender, REWARD);
  }

  function runAndPay(address _recipient) external {
    require(!executed, "already executed");
    executed = true;
    TOKEN.transfer(_recipient, REWARD / 2);
    TOKEN.transfer(msg.sender, REWARD / 2);
  }
}
