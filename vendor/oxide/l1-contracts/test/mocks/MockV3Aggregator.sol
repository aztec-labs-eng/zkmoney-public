// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";

contract MockV3Aggregator is AggregatorV3Interface {
  uint8 internal feedDecimals;
  int256 internal answer;
  uint256 internal updatedAtOverride;

  constructor(uint8 _decimals, int256 _answer) {
    feedDecimals = _decimals;
    answer = _answer;
  }

  function setAnswer(int256 _answer) external {
    answer = _answer;
  }

  function setUpdatedAt(uint256 _updatedAt) external {
    updatedAtOverride = _updatedAt;
  }

  function decimals() external view override returns (uint8) {
    return feedDecimals;
  }

  function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
    return (0, answer, 0, updatedAtOverride == 0 ? block.timestamp : updatedAtOverride, 0);
  }
}
