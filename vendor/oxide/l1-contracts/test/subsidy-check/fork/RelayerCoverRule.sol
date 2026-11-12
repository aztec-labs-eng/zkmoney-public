// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Math} from "@oz/utils/math/Math.sol";

library RelayerCoverRule {
  uint256 internal constant CALLDATA_PADDING = 768;
  uint256 internal constant SIMULATION_GAS_LIMIT = 15_000_000;

  function confirmationLimit(uint256 _simulatedGas) internal pure returns (uint256) {
    return Math.min(_simulatedGas * 3 / 2, SIMULATION_GAS_LIMIT);
  }

  function submissionLimit(uint256 _confirmationLimit) internal pure returns (uint256) {
    return _confirmationLimit + CALLDATA_PADDING;
  }

  function gasToCover(uint256 _simulatedGas, uint256 _submissionLimit) internal pure returns (uint256) {
    return Math.max(_simulatedGas + CALLDATA_PADDING, Math.ceilDiv(2 * _submissionLimit, 3));
  }

  function tokenWeiPerEth(uint256 _ethUsd18, uint8 _tokenDecimals, uint256 _tokenUsd18)
    internal
    pure
    returns (uint256)
  {
    return Math.ceilDiv(_ethUsd18 * 10 ** _tokenDecimals, _tokenUsd18);
  }

  function quotedGasCost(uint256 _gasToCover, uint256 _gasPrice, uint256 _tokenWeiPerEth)
    internal
    pure
    returns (uint256)
  {
    return Math.mulDiv(_gasToCover * _gasPrice, _tokenWeiPerEth, 1e18, Math.Rounding.Ceil);
  }
}
