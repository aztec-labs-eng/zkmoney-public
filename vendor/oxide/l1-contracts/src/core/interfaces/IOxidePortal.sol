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

  struct RefundFrozenDepositArgs {
    address executor;
    bytes userPayload;
    bytes relayerPayload;
    uint256 amount;
    bytes32 siloedNullifier;
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
    bytes32[] inboxSiblingPath;
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

  function approveTeePcr0(bytes32 _pcr0Hash) external;

  function verifyTeeCACert(bytes calldata _cert, bytes32 _parentCertHash) external returns (bytes32 certHash);

  function verifyTeeClientCert(bytes calldata _cert, bytes32 _parentCertHash) external returns (bytes32 certHash);

  function verifyTeeAttestationHash(bytes calldata _attestationTbs) external returns (bytes32 attestationTbsKeccak);

  function verifyTeeAttestationSig(bytes32 _attestationTbsKeccak, bytes calldata _signature, bytes32 _leafCertHash)
    external;

  function registerTee(
    bytes calldata _attestationTbs,
    bytes calldata _signature,
    bytes32 _teePubKeyX,
    bytes32 _teePubKeyY,
    bytes32 _encPubKeyX,
    bytes32 _encPubKeyY
  ) external returns (bytes32 key, uint256 index);

  function initialize(bytes32 _l2Portal) external;

  function UNDERLYING() external view returns (IERC20);

  function ROLLUP_VERSION() external view returns (uint256);

  function ROLLUP() external view returns (IRollup);

  function L2_PORTAL() external view returns (bytes32);

  function $frozen() external view returns (bool);

  function freeze() external;

  function withdraw(WithdrawArgs calldata _args) external;

  function refundFrozenNotes(RefundFrozenNotesArgs calldata _args) external;

  function refundFrozenDeposit(RefundFrozenDepositArgs calldata _args) external;

  function refundUnprocessedDeposit(RefundUnprocessedDepositArgs calldata _args) external;

  function claimProverTips(IProverSubsidy _proverSubsidy, ProverTipClaim[] calldata _claims)
    external
    returns (uint256 totalSubsidy);

  function prepareFirstProver(uint256 _checkpointNumber, address _prover) external;

  function recordFirstProver(uint256 _checkpointNumber, uint256 _proofLength, address _prover) external;

  function isTeeActive(address _tee) external view returns (bool);
}
