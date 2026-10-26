// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IProverSubsidy} from "@core/interfaces/IProverSubsidy.sol";
import {ProverClaimLib} from "@core/lib/ProverClaimLib.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";

interface IOxidePortal {
  struct WithdrawContent {
    address executor;
    bytes32 userPayloadHash;
    uint256 amount;
    uint256 proverTip;
    uint256 randomness;
  }

  struct WithdrawArgs {
    WithdrawContent content;
    bytes userPayload;
    bytes relayerPayload;
    uint256 epochNumber;
    uint256 numCheckpointsInEpoch;
    uint256 leafIndex;
    bytes32[] path;
    uint256 checkpointNumber;
    bytes32 withdrawalId;
    bytes teeSignature;
  }

  struct RefundFrozenNotesArgs {
    address executor;
    bytes userPayload;
    bytes relayerPayload;
    uint256 amount;
    bytes32[] nullifiers;
    bytes proof;
    bytes teeSignature;
  }

  struct RefundFrozenDepositsArgs {
    address executor;
    bytes userPayload;
    bytes relayerPayload;
    uint256 amount;
    bytes32[] nullifiers;
    bytes proof;
    bytes teeSignature;
  }

  struct RefundUnprocessedDepositArgs {
    address executor;
    bytes userPayload;
    bytes relayerPayload;
    uint256 amount;
    bytes32 siloedNullifier;
    bytes32 messageHash;
    uint256 messageLeafIndex;
    bytes proof;
    bytes teeSignature;
  }

  struct ProverClaimArgs {
    WithdrawContent content;

    uint256 checkpointNumber;
    bytes32 withdrawalId;
    bytes teeSignature;
  }

  struct ProverTipClaim {
    ProverClaimArgs args;
    ProverClaimLib.ProverClaim proof;
  }

  function deposit(bytes32 recipientCommitment, uint256 amount)
    external
    returns (bytes32 key, uint256 index, uint256 creditedAmount);

  function UNDERLYING() external view returns (IERC20);

  function ROLLUP_VERSION() external view returns (uint256);

  function ROLLUP() external view returns (IRollup);

  function L2_TOKEN() external view returns (bytes32);

  function $frozen() external view returns (bool);

  function freeze() external;

  function withdraw(WithdrawArgs calldata _args) external;

  function refundFrozenNotes(RefundFrozenNotesArgs calldata _args) external;

  function refundFrozenDeposits(RefundFrozenDepositsArgs calldata _args) external;

  function refundUnprocessedDeposit(RefundUnprocessedDepositArgs calldata _args) external;

  function claimProverTips(IProverSubsidy _proverSubsidy, ProverTipClaim[] calldata _claims)
    external
    returns (uint256 totalSubsidy);
}
