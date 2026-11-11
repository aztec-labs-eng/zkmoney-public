/** The stages of one proof, as the prover reports them. */
export const ProvingStage = {
  Simulating: "simulating",
  Witgen: "witgen",
  Proving: "proving",
  Mining: "mining",
} as const

export type ProvingStage = (typeof ProvingStage)[keyof typeof ProvingStage]

/**
 * The user's source flows. Every proving operation is one of these; the value is stored on
 * `BaseTransaction.kind`, passed as `wallet.sendTx`'s `opts.kind`, and prefixes the operation id
 * the wallet mints.
 */
export type OriginalFlowKind =
  | "send"
  | "withdraw"
  | "paylink-create"
  | "paylink-claim"
  | "paylink-refund"

/** Kind discriminator of a proving operation. Identical to `OriginalFlowKind`. */
export type TxKind = OriginalFlowKind
