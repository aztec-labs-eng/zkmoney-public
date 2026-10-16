/** What a frozen source refunds in one batch: notes together, a deposit alone. */
export type FrozenRefundKind = "note" | "frozen-deposit" | "unprocessed-deposit"

/** A swept deposit's public refund inputs, as found on L1. Strings only; the shared secret salt is never logged. */
export interface FrozenDepositDescriptor {
  /** Fr hex. */
  messageKey: string
  /** Inbox global leaf index, decimal. */
  messageLeafIndex: string
  /** L1 block of the portal `Deposit` event, decimal. */
  l1BlockNumber: string
  /** Fr hex. */
  sharedSecretSalt: string
  /** Credited amount, decimal. */
  amount: string
}

/** Public recovery coordinates. Never contains source keys or a destination message secret. */
export interface MigrationFundingBatch {
  binding: string
  recipient: string
  amount: string
  /** What the source withholds before the recipient: relayer tip plus any source funding cut. */
  exitFee: string
  fromBlock: string
  burnTx?: string
  broadcastTx?: string
  day?: number
  nonce?: number
  received?: boolean
  /** Source generation identifiers, never note preimages or keys. */
  sourceSelection?: string[]
  /** Absent on records written before deposit refunds: notes. */
  sourceKind?: FrozenRefundKind
}
