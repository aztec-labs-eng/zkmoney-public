/**
 * Flow-kind vocabulary shared by the SDK wallet and front-core. Types-only.
 */

/**
 * The user's source flows. Every proving operation is one of these; the value
 * is stored on `BaseTransaction.kind`, passed as `wallet.sendTx`'s `opts.kind`,
 * and prefixes the operation id minted by `nextOperationId`.
 */
export type OriginalFlowKind =
  | "send"
  | "withdraw"
  | "paylink-create"
  | "paylink-claim"
  | "paylink-refund"

/** Kind discriminator of a proving operation. Identical to `OriginalFlowKind`. */
export type TxKind = OriginalFlowKind
