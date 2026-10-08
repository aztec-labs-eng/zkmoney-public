// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IWithdrawalSubsidy} from "@periphery/interfaces/IWithdrawalSubsidy.sol";

contract ReenteringWithdrawalSubsidy is IWithdrawalSubsidy {
  address public hookTarget;
  bytes public hookData;
  bool public bubble;

  uint256 public calls;
  bool public hookSucceeded;
  bytes public hookResult;

  function arm(address _target, bytes calldata _data, bool _bubble) external {
    hookTarget = _target;
    hookData = _data;
    bubble = _bubble;
  }

  function paySubsidy(IExecutor.Flow, address) external override(IWithdrawalSubsidy) returns (uint256) {
    calls++;
    address target = hookTarget;
    if (target == address(0)) {
      return 0;
    }
    hookTarget = address(0);
    (bool success, bytes memory returned) = target.call(hookData);
    if (!success && bubble) {
      assembly {
        revert(add(returned, 0x20), mload(returned))
      }
    }
    hookSucceeded = success;
    hookResult = returned;
    return 0;
  }
}
