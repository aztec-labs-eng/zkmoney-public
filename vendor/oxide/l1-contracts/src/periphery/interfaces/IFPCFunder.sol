// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aztec Labs.
pragma solidity >=0.8.27;

import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

interface IFPCFunder {
  event Funded(uint256 feeAssetAmount, uint256 bounty, bytes32 key, uint256 index);

  function swapAndDepositAsFeeJuice() external returns (bytes32 key, uint256 index);

  function quoteBalanceAndBounty() external view returns (uint256 balance, uint256 bounty);

  function inputToken() external view returns (IERC20);

  function FEE_ASSET() external view returns (IERC20);

  function FEE_JUICE_PORTAL() external view returns (IFeeJuicePortal);

  function L2_BENEFICIARY() external view returns (bytes32);
}
