// Alpha account (default exports)
export { ObsidionAccount } from "./alpha/account/ObsidionAccount.js"
export { ObsidionAccountContractManager } from "./alpha/account/ObsidionAccountContractManager.js"
export { ObsidionAccountEntrypoint } from "./alpha/account/ObsidionAccountEntrypoint.js"
export * from "./alpha/auth/index.js"
export * from "./ObsidionWallet.js"
export * from "./ObsidionAlphaTestWallet.js"
// Staged execution: the generic finalize-against-simulation primitive
// consumed by `ObsidionWallet.sendTx` and produced by `buildTeeOperation`
export {
  InvalidEffectDeltasError,
  ProvenGasExceedsLimitsError,
  assertProvenGasWithinLimits,
  priceDeclaredEffectDeltas,
  type DeclaredEffectDeltas,
  type FinalizedPayload,
  type PayloadFinalizer,
} from "./stagedExecution.js"
export { FeeUnavailableError } from "./FeeUnavailableError.js"
// Public proving-progress helper (PerfBucketAccumulator stays internal).
export {
  proveTxWithProgress,
  readTimingBenchFlag,
  setTimingBenchFlag,
} from "./proving-progress-helpers.js"

// Time-performance benchmark. Flag-gated (`readTimingBenchFlag`) and inert unless enabled.
export {
  benchmarkRegistry,
  type BenchmarkSampleSink,
  type TeeLegContribution,
  type ProveLegContribution,
} from "./benchmark/benchmarkRegistry.js"
export { extractProveTimings, type ProveTimingScalars } from "./benchmark/proveTimingExtract.js"
export {
  extractSimFunctions,
  normalizeFunctionName,
  NON_ALLOWLISTED,
} from "./benchmark/simFunctionExtract.js"
// Flow-kind types — re-exported from proving-progress, which owns them.
// See packages/proving-progress/src/race.ts.
export type { OriginalFlowKind, TxKind } from "@obsidion/proving-progress"
// Pending-tx store interface + in-memory default.
export {
  CLOCK_SKEW_MARGIN_MS,
  InMemoryPendingTxStore,
  MAX_TX_LIFETIME_MS,
  type IPendingTxStore,
  type PendingTxListListener,
  type PendingTxRecord,
  type PendingTxStoreListener,
} from "./pending/index.js"
// ObsidionWalletTest is NOT barrel-exported: it imports @aztec/pxe/server (Node.js-only)
// which pulls lmdb/native binaries into browser bundles. Import it directly where needed:
//   import { ObsidionWalletTest } from "@obsidion/sdk/obsidion/ObsidionWalletTest.js"

// ObsidionWalletBackend is NOT barrel-exported for the same reason (imports @aztec/pxe/server).
// Backend services should import directly:
//   import { ObsidionWalletBackend } from "@obsidion/sdk/obsidion/ObsidionWalletBackend.js"
