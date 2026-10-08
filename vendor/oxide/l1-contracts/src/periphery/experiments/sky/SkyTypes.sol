// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IDaiUsds} from "@periphery/experiments/sky/interfaces/IDaiUsds.sol";
import {ISUsds} from "@periphery/experiments/sky/interfaces/ISUsds.sol";

struct SkyRoute {
  IERC20 dai;
  IERC20 usds;
  ISUsds sUsds;
  IDaiUsds daiUsds;
}

uint8 constant SKY_ROUTE_STAKE = 0;
uint8 constant SKY_ROUTE_UNSTAKE = 1;

uint16 constant SKY_REFERRAL_CODE = 2014;
