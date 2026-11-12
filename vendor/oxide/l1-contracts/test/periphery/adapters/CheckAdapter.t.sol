// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {Errors} from "@periphery/Errors.sol";
import {CheckAdapter} from "@periphery/adapters/CheckAdapter.sol";

contract CheckAdapterTest is Test {
  CheckAdapter internal adapter;
  Target internal target;

  function setUp() external {
    adapter = new CheckAdapter();
    target = new Target();
  }

  function test_PassesWhenTheResultMatches() external view {
    adapter.check(address(target), abi.encodeCall(Target.value, ()), keccak256(abi.encode(uint256(7))));
  }

  function test_RevertsWhenTheResultDiffers() external {
    vm.expectRevert(Errors.CheckAdapter__ResultMismatch.selector);
    adapter.check(address(target), abi.encodeCall(Target.value, ()), keccak256(abi.encode(uint256(8))));
  }

  function test_RevertsWhenTheCallReverts() external {
    vm.expectRevert(Errors.CheckAdapter__CallReverted.selector);
    adapter.check(address(target), abi.encodeCall(Target.fail, ()), keccak256(""));
  }

  function test_RevertsOnATargetWithoutCode() external {
    vm.expectRevert(Errors.CheckAdapter__TargetHasNoCode.selector);
    adapter.check(makeAddr("noCode"), "", keccak256(""));
  }
}

contract Target {
  function value() external pure returns (uint256) {
    return 7;
  }

  function fail() external pure {
    revert("fail");
  }
}
