// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockCatchingOperation {
  IERC20 internal immutable TOKEN;
  uint256 internal immutable REWARD;
  uint256 internal immutable TIP;
  uint256 internal immutable WORK_ROUNDS;
  bool public workDone;
  bytes32 internal $workDigest;

  constructor(IERC20 _token, uint256 _reward, uint256 _tip, uint256 _workRounds) {
    TOKEN = _token;
    REWARD = _reward;
    TIP = _tip;
    WORK_ROUNDS = _workRounds;
  }

  function run() external {
    try this.work(msg.sender) {} catch {}
    TOKEN.transfer(msg.sender, TIP);
  }

  function work(address _payoutTo) external {
    require(msg.sender == address(this), "only self");
    uint256 rounds = WORK_ROUNDS;
    bytes32 digest;
    assembly ("memory-safe") {
      for { let i := 0 } lt(i, rounds) { i := add(i, 1) } {
        mstore(0, digest)
        mstore(32, i)
        digest := keccak256(0, 64)
      }
    }
    $workDigest = digest;
    workDone = true;
    TOKEN.transfer(_payoutTo, REWARD);
  }
}
