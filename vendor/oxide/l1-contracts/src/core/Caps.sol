// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Math} from "@oz/utils/math/Math.sol";
import {Errors} from "@core/lib/Errors.sol";

abstract contract Caps {
  uint128 public immutable TX_AMOUNT_CAP;
  uint256 public immutable RATE;
  uint256 public immutable GLOBAL_LIMIT;

  uint256 public $lastUpdatedTime;
  uint256 public $cachedAvailable;

  constructor(uint128 _txAmountCap, uint256 _rate, uint256 _globalLimit) {
    TX_AMOUNT_CAP = _txAmountCap;
    RATE = _rate;
    GLOBAL_LIMIT = _globalLimit;

    $lastUpdatedTime = block.timestamp;
    $cachedAvailable = _globalLimit;
  }

  function getCurrentAvailable() public view returns (uint256) {
    uint256 increase = (block.timestamp - $lastUpdatedTime) * RATE;
    return Math.min($cachedAvailable + increase, GLOBAL_LIMIT);
  }

  function _markUsage(uint256 _amount) internal {
    require(_amount <= TX_AMOUNT_CAP, Errors.Caps__TxLimitSurpassed());
    uint256 available = getCurrentAvailable();
    require(_amount <= available, Errors.Caps__GlobalLimitSurpassed());

    $lastUpdatedTime = block.timestamp;
    $cachedAvailable = available - _amount;
  }
}
