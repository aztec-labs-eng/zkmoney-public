// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

library Errors {
  error Caps__TxLimitSurpassed();
  error Caps__GlobalLimitSurpassed();

  error OxidePortal__AlreadyInitialized();
  error OxidePortal__Uninitialized();
  error OxidePortal__ZeroL2Portal();
  error OxidePortal__ZeroRecipientCommitment();
  error OxidePortal__AmountNotAboveFpcFundingCut();
  error OxidePortal__WithdrawalAlreadyClaimed();
  error OxidePortal__InvalidWithdrawalExecutor();
  error OxidePortal__InvalidUserPayload();
  error OxidePortal__ProverTipExceedsAmount();
  error OxidePortal__WithdrawalProverClaimAlreadyMade(bytes32 withdrawalId);
  error OxidePortal__UnregisteredTEE();
  error OxidePortal__AmountTooLarge();
  error OxidePortal__UnknownCheckpoint();
  error OxidePortal__UnprovenCheckpoint();
  error OxidePortal__FrozenPortal();
  error OxidePortal__NotFrozen();
  error OxidePortal__AlreadyFrozen();
  error OxidePortal__RollupStillCanonical();
  error OxidePortal__CheckpointPastFreeze();
  error OxidePortal__EpochPastFreeze();
  error OxidePortal__ProofDepthPastFreeze();
  error OxidePortal__EmptyFrozenNotesRefundNullifiers();
  error OxidePortal__TooManyFrozenNotesRefundNullifiers(uint256 count);
  error OxidePortal__ZeroRefundNullifier();
  error OxidePortal__RefundNullifierAlreadySpent(bytes32 nullifier);
  error OxidePortal__InvalidFrozenNotesRefundProof();
  error OxidePortal__InvalidFrozenDepositRefundProof();
  error OxidePortal__InvalidUnprocessedDepositRefundProof();
  error OxidePortal__InvalidProver();
  error OxidePortal__CheckpointAlreadyProven(uint256 checkpointNumber, uint256 provenCheckpointNumber);
  error OxidePortal__FirstProverNotPrepared(uint256 checkpointNumber, address prover);
  error OxidePortal__CheckpointNotJustProven(uint256 checkpointNumber, uint256 provenCheckpointNumber);
  error OxidePortal__FirstProverAlreadyRecorded(uint256 checkpointNumber, address existingFirstProver);
  error OxidePortal__InvalidProofLengthForCheckpoint(uint256 checkpointNumber, uint256 proofLength);
  error OxidePortal__ProverDidNotSubmit(address prover, uint256 epochNumber, uint256 proofLength);

  error ProverClaim__UnprovenEpoch(uint256 epochNumber);
  error ProverClaim__PathTooShort(uint256 pathLength, uint256 minimumPathLength);
  error ProverClaim__PathTooLong(uint256 pathLength);
  error ProverClaim__LeafIndexOutOfBounds(uint256 leafIndex, uint256 pathLength);
  error ProverClaim__CheckpointEpochMismatch(uint256 checkpointNumber, uint256 epochNumber);
  error ProverClaim__CheckpointNotEpochBoundary(uint256 checkpointNumber, uint256 epochNumber);
  error ProverClaim__ProofLengthBelowMessageCheckpoint(uint256 proofLength, uint256 messageCheckpointPosition);
  error ProverClaim__ProofCheckpointNotInEpoch(uint256 proofCheckpointNumber, uint256 epochNumber);
  error ProverClaim__ClaimAlreadyTracked(address portal, uint256 epochNumber, uint256 leafId);
  error ProverClaim__NotFirstProver(uint256 checkpointNumber, address firstProver);
  error ProverClaim__NoFirstProverInRange(uint256 messageCheckpointNumber, uint256 proofCheckpointNumber);

  error TEERegistration__ZeroTEE();
  error TEERegistration__OffCurveTEEPubKey();
  error TEERegistration__AlreadyRegistered();
  error TEERegistration__ZeroTEEPcr0Hash();
  error TEERegistration__DebugModeTEEPcr0Hash();
  error TEERegistration__MissingTEEPcr0();
  error TEERegistration__UnapprovedTEEPcr0(bytes32 pcr0Hash);
  error TEERegistration__StaleTEEAttestation();
  error TEERegistration__InvalidTEERegistrationUserData();

  error TeeRegistry__ZeroL2Recipient();
  error TeeRegistry__ZeroCertManager();
  error TeeRegistry__ZeroNitroValidator();
  error TeeRegistry__ZeroInbox();
  error TeeRegistry__CertManagerMismatch();
}
