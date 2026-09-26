// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

contract MockLegacyDepositPool {
  uint256 internal version;

  constructor(uint256 _version) {
    version = _version;
  }

  function setRollupVersion(uint256 _version) external {
    version = _version;
  }

  function rollupVersion() external view returns (uint256) {
    return version;
  }
}
