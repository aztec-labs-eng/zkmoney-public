// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC4626} from "@oz/interfaces/IERC4626.sol";

interface ISUsds is IERC4626 {
  event Referral(uint16 indexed referral, address indexed owner, uint256 assets, uint256 shares);

  function deposit(uint256 assets, address receiver, uint16 referral) external returns (uint256 shares);
}
