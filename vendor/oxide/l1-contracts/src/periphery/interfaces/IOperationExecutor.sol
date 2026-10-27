// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOperationExecutor {
  struct ExecutionContext {
    bool direct;
    bool startedEmpty;
    IERC20 payoutToken;
    uint256 headGas;
  }

  function executionContext() external view returns (ExecutionContext memory);
}
