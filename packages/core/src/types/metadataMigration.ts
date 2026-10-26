/**
 * What a frozen source refunds in one batch: the account's notes together, one payment link's notes
 * together, a deposit alone.
 */
export type FrozenRefundKind = "note" | "escrow-note" | "frozen-deposit" | "unprocessed-deposit"

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
  /** What its deposit pays on the destination, so activity can show what lands. */
  depositFee?: string
  fromBlock: string
  /** When it was planned, and when its carrier was sent: activity orders by them. */
  createdAt?: number
  sentAt?: number
  burnTx?: string
  broadcastTx?: string
  day?: number
  nonce?: number
  received?: boolean
  /** Its approval was given; a rebuild uses the saved one. */
  approved?: boolean
  /** Its refund executed on L1, whatever its carrier transaction's receipt says. */
  refunded?: boolean
  /** Its selection stopped holding before it was sent; a later plan covers its funds. */
  abandoned?: boolean
  /** Source generation identifiers, never note preimages or keys. */
  sourceSelection?: string[]
  /** Absent on records written before deposit refunds: notes. */
  sourceKind?: FrozenRefundKind
}
