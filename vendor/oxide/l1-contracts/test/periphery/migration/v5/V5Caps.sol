// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {V5OxideConstants} from "./V5OxideConstants.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {V5Errors} from "./V5Errors.sol";

abstract contract V5Caps {
  uint256 public immutable RATE;
  uint256 public immutable GLOBAL_LIMIT;

  uint256 public $lastUpdatedTime;
  uint256 public $cachedAvailable;

  constructor(uint256 _rate, uint256 _globalLimit) {
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
    require(_amount <= V5OxideConstants.TX_AMOUNT_CAP, V5Errors.Caps__TxLimitSurpassed());
    uint256 available = getCurrentAvailable();
    require(_amount <= available, V5Errors.Caps__GlobalLimitSurpassed());

    $lastUpdatedTime = block.timestamp;
    $cachedAvailable = available - _amount;
  }
}
