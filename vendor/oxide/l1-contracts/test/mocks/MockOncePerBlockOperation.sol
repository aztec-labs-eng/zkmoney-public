// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockOncePerBlockOperation {
  IERC20 internal immutable TOKEN;
  uint256 internal immutable REWARD;
  uint256 internal immutable FIRST_IN_BLOCK_REWARD;
  uint256 internal immutable WORK_ROUNDS;
  uint256 public lastWorkTime;
  bytes32 internal $workDigest;

  constructor(IERC20 _token, uint256 _reward, uint256 _firstInBlockReward, uint256 _workRounds) {
    TOKEN = _token;
    REWARD = _reward;
    FIRST_IN_BLOCK_REWARD = _firstInBlockReward;
    WORK_ROUNDS = _workRounds;
  }

  function poke() external {
    _workOncePerBlock();
  }

  function run() external {
    uint256 reward = REWARD;
    if (_workOncePerBlock()) {
      reward += FIRST_IN_BLOCK_REWARD;
    }
    TOKEN.transfer(msg.sender, reward);
  }

  function _workOncePerBlock() internal returns (bool) {
    if (lastWorkTime >= block.timestamp) {
      return false;
    }
    lastWorkTime = block.timestamp;
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
    return true;
  }
}
