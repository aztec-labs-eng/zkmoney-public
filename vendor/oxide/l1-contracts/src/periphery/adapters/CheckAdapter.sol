// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Errors} from "@periphery/Errors.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract CheckAdapter is CoreAdapter {
  // solhint-disable-next-line oxide/no-comments
  /// @notice Reverts unless a static call of `_target` with `_data` returns a result whose hash is `_resultHash`.
  function check(address _target, bytes calldata _data, bytes32 _resultHash) external view {
    require(_target.code.length > 0, Errors.CheckAdapter__TargetHasNoCode());
    (bool success, bytes memory result) = _target.staticcall(_data);
    require(success, Errors.CheckAdapter__CallReverted());
    require(keccak256(result) == _resultHash, Errors.CheckAdapter__ResultMismatch());
  }
}
