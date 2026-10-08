// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {MockSUsds} from "@test/periphery/experiments/sky/mocks/MockSUsds.sol";

contract ReenteringSUsds is MockSUsds {
  address public hookTarget;
  bytes public hookData;

  constructor(TestERC20 _usds, address _owner) MockSUsds(_usds, _owner) {}

  function arm(address _target, bytes calldata _data) external onlyOwner {
    hookTarget = _target;
    hookData = _data;
  }

  function _update(address _from, address _to, uint256 _value) internal override {
    super._update(_from, _to, _value);
    address target = hookTarget;
    if (target == address(0)) {
      return;
    }
    hookTarget = address(0);
    (bool success, bytes memory returned) = target.call(hookData);
    if (!success) {
      assembly {
        revert(add(returned, 0x20), mload(returned))
      }
    }
  }
}
