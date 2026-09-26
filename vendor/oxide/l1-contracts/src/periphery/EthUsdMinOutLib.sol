// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {Errors} from "@periphery/Errors.sol";

library EthUsdMinOutLib {
  uint256 internal constant BPS_DENOMINATOR = 10_000;
  uint256 internal constant MAX_PRICE_AGE = 1 hours + 5 minutes;

  function ethMinOut(AggregatorV3Interface _feed, uint256 _usdIn, uint256 _slippageBps)
    internal
    view
    returns (uint256)
  {
    (, int256 answer,, uint256 updatedAt,) = _feed.latestRoundData();
    require(answer > 0, Errors.EthUsdMinOut__InvalidPrice(answer));
    require(block.timestamp - updatedAt <= MAX_PRICE_AGE, Errors.EthUsdMinOut__StalePrice(updatedAt));
    return (_usdIn * 10 ** _feed.decimals() * (BPS_DENOMINATOR - _slippageBps)) / (uint256(answer) * BPS_DENOMINATOR);
  }
}
