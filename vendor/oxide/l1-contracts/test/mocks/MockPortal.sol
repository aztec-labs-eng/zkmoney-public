// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";

contract MockPortal {
  IERC20 public immutable UNDERLYING;

  uint256 internal version;
  bytes32 internal l2Portal;

  constructor(IERC20 _underlying, uint256 _version) {
    UNDERLYING = _underlying;
    version = _version;
  }

  function setRollupVersion(uint256 _version) external {
    version = _version;
  }

  function setL2Portal(bytes32 _l2Portal) external {
    l2Portal = _l2Portal;
  }

  function L2_PORTAL() external view returns (bytes32) {
    return l2Portal;
  }

  function ROLLUP_VERSION() external view returns (uint256) {
    return version;
  }
}
