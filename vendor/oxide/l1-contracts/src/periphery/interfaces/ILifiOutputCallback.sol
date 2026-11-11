// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface ILifiOutputCallback {
  function outputFilled(bytes32 token, uint256 amount, bytes calldata executionData) external;
}
