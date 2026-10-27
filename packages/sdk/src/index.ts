// Re-export everything from @obsidion/contracts so existing consumers don't break
export * from "@obsidion/contracts"

// SDK-specific exports
export * from "./oxide/publishDaLogs.js"
export * from "./oxide/burnWithdrawals.js"
export * from "./oxide/withdrawalFinalization.js"
export * from "./oxide/portalIdentity.js"
export * from "./oxide/withdrawFinalizationCall.js"
export * from "./oxide/withdrawalExecutor.js"
export * from "./oxide/swapOnWithdrawSimulator.js"
export * from "./oxide/swapOnWithdraw.js"
export * from "./oxide/skySavings.js"
export * from "./oxide/swapEscrowReader.js"
export * from "./oxide/portalCapacity.js"
export * from "./oxide/tokenRegistration.js"
export * from "./oxide/portalCapError.js"
export * from "./oxide/sipaPortalTerms.js"
export * from "./oxide/deploymentTable.js"
export * from "./oxide/proverTipQuote.js"
export * from "./oxide/tipQuote.js"
export {
  assertBackupSweepProfitable,
  quoteBackupSweep,
  UnprofitableSweepError,
  type BackupSweepQuote,
} from "./oxide/l1OperationQuote.js"
export type { PlainWithdrawalContext } from "./oxide/plainWithdrawal.js"
export { readPlainWithdrawalFee } from "@oxide/oxide-client/executors/plain_withdrawal_executor.js"
export * from "./email/index.js"
export * from "./feePaymentMethod/index.js"
export * from "./obsidion/index.js"
export * from "./services/index.js"
export * from "./utils/index.js"
export * from "./xmtp/index.js"
export * from "./node/createNode.js"

// RegistrationIntent + K1PointArg surface from both @obsidion/contracts (core's
// registration-by-deposit mirror) and services/sipaIntents (oxide's intent type). Both carry the
// identity record plus the routing; oxide's is canonical, so re-export it explicitly to resolve
// the star-export ambiguity.
export type { RegistrationIntent, K1PointArg } from "./services/sipaIntents.js"
