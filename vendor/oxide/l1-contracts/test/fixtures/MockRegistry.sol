// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IHaveVersion} from "@aztec/governance/interfaces/IRegistry.sol";

contract MockRegistry {
  IHaveVersion internal canonicalRollup;
  mapping(uint256 version => IHaveVersion rollup) internal rollups;

  function setCanonicalRollup(IHaveVersion _canonicalRollup) external {
    canonicalRollup = _canonicalRollup;
  }

  function getCanonicalRollup() external view returns (IHaveVersion) {
    return canonicalRollup;
  }

  function setRollup(uint256 _version, IHaveVersion _rollup) external {
    rollups[_version] = _rollup;
  }

  function getRollup(uint256 _version) external view returns (IHaveVersion) {
    IHaveVersion rollup = rollups[_version];
    require(address(rollup) != address(0), "MockRegistry: unknown version");
    return rollup;
  }
}
