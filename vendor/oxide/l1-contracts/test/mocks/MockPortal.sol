// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";

contract MockPortal {
  IERC20 public immutable UNDERLYING;

  bool public $frozen;

  uint256 internal version;
  bytes32 internal l2Token;

  constructor(IERC20 _underlying, uint256 _version) {
    UNDERLYING = _underlying;
    version = _version;
  }

  function setRollupVersion(uint256 _version) external {
    version = _version;
  }

  function setL2Token(bytes32 _l2Token) external {
    l2Token = _l2Token;
  }

  function L2_TOKEN() external view returns (bytes32) {
    return l2Token;
  }

  function ROLLUP_VERSION() external view returns (uint256) {
    return version;
  }

  function ROLLUP() external view returns (address) {
    return address(this);
  }

  function REGISTRY() external view returns (address) {
    return address(this);
  }

  function getCanonicalRollup() external view returns (address) {
    return address(this);
  }
}
