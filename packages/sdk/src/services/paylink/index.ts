/**
 * Paylink processor module
 * Provides type-specific processors for handling different paylink commitments
 */

export { PaylinkProcessorFactory } from "./PaylinkProcessorFactory.js"
export { BasePaylinkProcessor } from "./processors/BasePaylinkProcessor.js"
export type { DepositArg, PaylinkConstructorArgs } from "./processors/BasePaylinkProcessor.js"
export { DirectPaylinkProcessor } from "./processors/DirectPaylinkProcessor.js"
export { EmailPaylinkProcessor } from "./processors/EmailPaylinkProcessor.js"
export {
  assertLinkChain,
  assertLinkClass,
  encodePaylinkInline,
  decodePaylinkInline,
} from "./paylinkInlineCodec.js"
export { buildOperationCall } from "./paylinkClaimSubmit.js"
export { paylinkL1Caller } from "./paylinkL1Claim.js"
export type { PaylinkL1Payout, PaylinkL1Proof } from "./paylinkL1Claim.js"
export {
  exitPaylinkWithVoucher,
  paylinkVoucherUses,
  readPaylinkEscrowNote,
  type PaylinkExitArgs,
  type PaylinkVoucherDeps,
} from "./paylinkVoucher.js"
export { makePaylinkSpendMetadataResolver } from "./paylinkSpendMetadata.js"
export {
  buildPaylinkNoteView,
  unpackPaylinkData,
  type PaylinkClaimWindowStatus,
  type PaylinkNoteData,
  type PaylinkNoteView,
  type RawPaylinkNote,
} from "./paylinkNoteData.js"
export {
  buildPaylinkCompleteAddress,
  deriveDeterministicPaylinkKeys,
  derivePaylinkKeys,
  derivePaylinkFallbackSecretKey,
  MAX_PAYLINK_NONCES_PER_DAY,
  reconstructPaylinkPublicKeys,
  registerPaylinkContractWithKeys,
  type PaylinkDerivedKeyMaterial,
  type PaylinkKeyMaterial,
} from "./paylinkKeys.js"
export {
  findDepositTxHash,
  findEscrowDepositTx,
  PAYLINK_NONCE_EPOCH_DAY,
  scanPaylinkEscrows,
  type PaylinkScanNode,
  type RecoveredPaylinkEscrow,
} from "./paylinkRecovery.js"
export type {
  CommitmentInput,
  DirectClaimInput,
  EmailCommitmentInput,
  ClaimInput,
  BaseClaimInput,
  ZkProofClaimInput,
  isZkProofClaimInput,
  ClaimService,
  ClaimTransactionResult,
} from "./types.js"
export * from "./goldenTicket.js"
