import { QueueStatus } from "@obsidion/sdk"
import type { OriginalFlowKind } from "@obsidion/proving-progress"
import { TokenAction, TokenInTxService, PaylinkAction } from "./tokens"
import type { TxStatus } from "@aztec/stdlib/tx"

// TransactionType discriminates the storage shape. This alias is consumed
// by the optional `TransactionQueueItem.type` field; it is not a persisted
// row field, so the rename from "emailPayment" → "paylink" needs no read-time
// projection. Stored row classification flows through `emailPaymentAction`
// (legacy field name kept for back-compat) and the new `flavor` discriminator.
export type TransactionType = "paylink" | "token"

// Add a new action type for faucet transactions
export type FaucetAction = "faucet"
export enum FaucetActionEnum {
  FAUCET = "faucet",
}

export type TransactionStatus = "pending" | "success" | "failed"

export type AccountCreationAction = "create_account" | "import_account"
// More detailed status that mirrors the queue status

// Base transaction type with common fields
export type BaseTransaction = {
  timestamp: number
  status: TransactionStatus
  txHash: string
  // Real-time tracking fields
  queueId?: string
  // caller-supplied opId threaded from React → wallet.sendTx so
  // proving-progress stage events can be correlated to this row before/after submit. Required
  // for the in-memory queue→storage write-through bridge in TxLifecycleService; absence means
  // the row pre-dates async-send and the bridge skips it.
  operationId?: string
  detailedStatus?: QueueStatus
  progress?: number
  error?: string
  startTime?: number
  endTime?: number
  estimatedDuration?: number
  description?: string
  /**
   * Original-flow kind — the user's source flow (`"send"`, `"withdraw"`,
   * or `"paylink-create"`).
   * Default `"send"` on read for back-compat with legacy persisted records
   * that pre-date the kind field.
   */
  kind?: OriginalFlowKind
  /** Network the row was created on (rollup L1 address). Unset only pre-boot. */
  networkId?: string
  // Reorg anchors: block inclusion data, re-writable on re-inclusion.
  blockNumber?: number
  blockHash?: string
  /** Internal six-tier status; the binary `status` stays the user-facing truth. */
  tier?: TxStatus
  /** Incremented on each reorg demote; stale forward writes carry an older epoch. */
  reorgEpoch?: number
}

// Token-related transaction.
//
// For `action: "send"`, `to` holds the recipient and `from` is the local user.
// For `action: "receive"`, `from` holds the sender (tag or raw L2 address) and
// `to` is the local user. The fields below `memo` are populated by the
// chain-native ingest (see core/services/transactions/TransferEventScanner.ts).
export type TokenTransaction = BaseTransaction & {
  action: TokenAction
  token: TokenInTxService
  from?: string
  to?: string
  // Sender-attached note: persisted on an outgoing send, or decoded from an incoming transfer's on-chain meta.
  memo?: string
  senderL2Address?: string
  /** Recipient's @tag on an outgoing send, so a send to someone not saved still reads as them. */
  toTag?: string
  /** Payment request this transfer fulfills (from the on-chain `Transfer.meta`). */
  requestId?: string
  /** Verifier-attested raw amount in base units (scanned rows only). Trusted, unlike `token.amount`'s wire-decimals display. */
  amountAtomic?: string
}

export type ContractCallTransaction = BaseTransaction & {
  action: "contract_call"
  from: string
  to: string
  functionName: string
}
// Add new Faucet transaction type
export type FaucetTransaction = BaseTransaction & {
  action: FaucetAction
  token: TokenInTxService
  // We could add additional faucet-specific fields here if needed
}

// PaylinkTransaction (formerly EmailPaymentTransaction) — represents a paylink
// row in either flavor (direct or email). The persisted field name
// `emailPaymentAction` is kept unchanged for back-compat with stored rows; new
// rows write `flavor` to distinguish direct vs email-validated paylinks (legacy
// rows are read-time projected by recipient-shape heuristic in TransactionStorage).
export type PaylinkTransaction = BaseTransaction & {
  action: PaylinkAction
  token?: TokenInTxService
  /**
   * Persisted action discriminator, kept under its legacy field name
   * `emailPaymentAction` so stored rows from before the EmailPayment→Paylink
   * rename continue to decode. New rows still write this field; the rename is
   * type-level only at this layer.
   */
  emailPaymentAction: PaylinkAction
  /**
   * Discriminates direct paylinks (no recipient validation) from email
   * paylinks (email-bound). Required on new writes; legacy rows missing this
   * field get a recipient-shape heuristic projection at read time.
   */
  flavor: "direct" | "email" | "zk"
  from?: string
  to?: string
  payToEmailSecret?: string
  obsidionAccountAddress?: string
  partialAddress?: string
  // The escrow's fallback secret, stamped once the create has its keys: the creator's migration
  // factor, never in the link.
  fallbackSecret?: string
  /** v4-era rows only; the frozen v4 exit runtime reads it. */
  taggingSecret?: string
  /**
   * Claim-window timestamps (unix seconds). Not encoded in the link, persisted here.
   */
  fromClaimable?: number
  untilClaimable?: number
  /** End of the creator refund window (unix seconds), which opens at creation. */
  refundableUntil?: number
  tokenAddress?: string
  paylink?: string
  /** Creator's memo: set at create; on a claim row, read from the escrow note. */
  memo?: string
  isRefunded?: boolean
  /**
   * The refund transaction that returned this link's escrow. The refund has no activity row of its
   * own — the create row carries the whole round trip — so this is where its hash is readable.
   */
  refundTxHash?: string
  isClaimed?: boolean
  // Escrow exited by the v4->v5 migration and landed on L1. No chain signal ever reaches this row
  // post-cutover (the reconciler polls the canonical node), so this local flip is the only truth.
  isMigrated?: boolean
}

export type AccountCreationTransaction = BaseTransaction & {
  action: AccountCreationAction
  accountAddress?: string
  isDevMode?: boolean
  hasEmail?: boolean
}

// Union type for all transaction types
export type Transaction =
  | TokenTransaction
  | FaucetTransaction
  | PaylinkTransaction
  | AccountCreationTransaction
  | ContractCallTransaction
