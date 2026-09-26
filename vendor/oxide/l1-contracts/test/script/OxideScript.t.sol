// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";

import {OxideScript} from "../../script/OxideScript.sol";
import {FakeEnv} from "../helpers/FakeEnv.sol";

contract EnvHarness is FakeEnv {
  function addressOr(string memory _name, address _default) external view returns (address) {
    return _envOr(_name, _default);
  }

  function uintOr(string memory _name, uint256 _default) external view returns (uint256) {
    return _envOr(_name, _default);
  }

  function boolOr(string memory _name, bool _default) external view returns (bool) {
    return _envOr(_name, _default);
  }

  function stringOr(string memory _name, string memory _default) external view returns (string memory) {
    return _envOr(_name, _default);
  }

  function addressOf(string memory _name) external view returns (address) {
    return _envAddress(_name);
  }

  function uintOf(string memory _name) external view returns (uint256) {
    return _envUint(_name);
  }

  function bytes32Of(string memory _name) external view returns (bytes32) {
    return _envBytes32(_name);
  }
}

contract OxideScriptTest is Test {
  EnvHarness internal env;

  function setUp() public {
    env = new EnvHarness();
  }

  function test_GivenMissingValue_ThenOptionalReadsUseTheDefault() public view {
    assertEq(env.addressOr("A", address(0xA11CE)), address(0xA11CE));
    assertEq(env.uintOr("U", 7), 7);
    assertEq(env.boolOr("B", true), true);
    assertEq(env.stringOr("S", "default"), "default");
  }

  function test_GivenEmptyValue_ThenItCountsAsMissing() public {
    env.withEnv("A", "");
    env.withEnv("S", "");

    assertEq(env.addressOr("A", address(0xA11CE)), address(0xA11CE));
    assertEq(env.stringOr("S", "default"), "default");

    vm.expectRevert(abi.encodeWithSelector(OxideScript.OxideScript__MissingEnv.selector, "A"));
    env.addressOf("A");
  }

  function test_GivenMissingValue_ThenRequiredReadsRevert() public {
    vm.expectRevert(abi.encodeWithSelector(OxideScript.OxideScript__MissingEnv.selector, "U"));
    env.uintOf("U");

    vm.expectRevert(abi.encodeWithSelector(OxideScript.OxideScript__MissingEnv.selector, "H"));
    env.bytes32Of("H");
  }

  function test_GivenSetValue_ThenReadsParseIt() public {
    env.withEnv("A", vm.toString(address(0xB0B)));
    env.withEnv("U", "42");
    env.withEnv("B", "true");
    env.withEnv("S", "out/manifest.json");
    env.withEnv("H", vm.toString(bytes32(uint256(0xFBC))));

    assertEq(env.addressOr("A", address(0)), address(0xB0B));
    assertEq(env.addressOf("A"), address(0xB0B));
    assertEq(env.uintOr("U", 7), 42);
    assertEq(env.uintOf("U"), 42);
    assertEq(env.boolOr("B", false), true);
    assertEq(env.stringOr("S", "default"), "out/manifest.json");
    assertEq(env.bytes32Of("H"), bytes32(uint256(0xFBC)));
  }

  function test_GivenZeroOrFalse_ThenTheValueWinsOverTheDefault() public {
    env.withEnv("U", "0");
    env.withEnv("B", "false");

    assertEq(env.uintOr("U", 7), 0);
    assertEq(env.boolOr("B", true), false);
  }

  function test_GivenMalformedValue_ThenOptionalReadsRevert() public {
    env.withEnv("A", "not-an-address");
    vm.expectRevert();
    env.addressOr("A", address(0xA11CE));

    env.withEnv("U", "12abc");
    vm.expectRevert();
    env.uintOr("U", 7);

    env.withEnv("B", "yes");
    vm.expectRevert();
    env.boolOr("B", true);
  }

  function test_GivenRemovedValue_ThenTheDefaultReturns() public {
    env.withEnv("U", "42");
    env.withoutEnv("U");

    assertEq(env.uintOr("U", 7), 7);
  }
}
