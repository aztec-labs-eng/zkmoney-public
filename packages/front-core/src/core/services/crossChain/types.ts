import type { Address, Hex } from "viem"

/** A call the user's wallet signs on the origin chain. */
export interface BridgeTx {
  chainId: number
  to: Address
  data: Hex
  value?: bigint
}

/**
 * A bridge to an L1 address, exact output (`outputAmount` lands, the fee rides on top) or exact
 * input (`inputAmount` leaves, the fee comes out of it).
 */
export type BridgeInQuoteRequest = {
  originChainId: number
  inputToken: Address
  destinationChainId: number
  outputToken: Address
  /** `outputToken`'s symbol, as the wallet lists it. */
  outputSymbol: string
  depositor: Address
  recipient: Address
} & ({ outputAmount: bigint; inputAmount?: never } | { inputAmount: bigint; outputAmount?: never })

/** Base units of the input token, except `outputAmount` and `expectedOutputAmount`, what lands. */
export interface BridgeInQuote {
  inputAmount: bigint
  /** The most the bridge call may pull, slippage included: what the approvals grant. */
  maxInputAmount: bigint
  outputAmount: bigint
  /** The most that lands: what the portal's limits are checked against. */
  expectedOutputAmount: bigint
  /** The most the bridge keeps, the one that leaves `outputAmount` landing. */
  fee: bigint
  /** `fee` in dollars, decimal, where the provider prices it. */
  feeUsd?: string
  /** What the deposit bridges, and a refund returns, when the input is swapped or wrapped first. */
  bridged?: { symbol: string; amount: bigint; decimals: number }
  fillSeconds: number
  /** ms; the bridge call reverts once mined after this. Undefined when the provider names none. */
  expiresAt?: number
  /** Approvals first, then the bridge call. */
  txs: BridgeTx[]
}

export type BridgeInStatus =
  | { status: "pending" }
  | { status: "filled"; fillTxHash: Hex }
  /** Returned to the depositor on the origin chain. */
  | { status: "refunded"; refundTxHash?: Hex }
  | { status: "expired" }
  /** Nothing left the wallet: the origin call reverted, lost its nonce, or outlived its quote. */
  | { status: "failed" }

export interface BridgeInProvider {
  quote(request: BridgeInQuoteRequest): Promise<BridgeInQuote>
  /** `undefined` until the provider sees the origin transaction. */
  status(originChainId: number, originTxHash: Hex): Promise<BridgeInStatus | undefined>
}

/** A bridge-in the provider knows by its deposit id: the origin call's hash, and its status. */
export interface BridgeInDeposit {
  originTxHash: Hex
  status: BridgeInStatus
}

export interface BridgeInDepositLookup {
  /** `undefined` until the provider sees the deposit. */
  statusById(originChainId: number, depositId: string): Promise<BridgeInDeposit | undefined>
}

/** Who a bridge-in pays where it is not this wallet's deposit: a request's payee. */
export interface BridgeInPays {
  /** The payee's tag. */
  payee: string
  requestId?: string
}

/** A bridge-in this front started, saved before the wallet signs its call. */
export interface BridgeInRecord {
  /** The store's key. */
  id: string
  /** The bridge call's hash, or its sped-up resend's once one replaced it; unset while signing. */
  originTxHash?: Hex
  /** Hashes a sped-up resend replaced, oldest first. */
  replacedHashes?: Hex[]
  originChainId: number
  depositor: Address
  /** The one-time deposit address the bridge pays on L1. */
  recipient: Address
  symbol: string
  /** Base-unit strings: what left the origin chain, what lands on L1, and the bridge's cut. */
  inputAmount: string
  outputAmount: string
  fee: string
  /** The fee in dollars, decimal, as quoted; unset when the quote had none. */
  feeUsd?: string
  /** `inputAmount` and `fee` are in the origin token's decimals, `outputAmount` in `outputSymbol`'s. */
  inputDecimals: number
  outputSymbol: string
  outputDecimals: number
  /** What the bridge carries, and a refund returns, where it is not `symbol`. Base units. */
  bridged?: { symbol: string; amount: string; decimals: number }
  /** `signing` until the wallet returns the call's hash or the chain shows where its nonce went. */
  status: "signing" | BridgeInStatus["status"]
  fillTxHash?: Hex
  refundTxHash?: Hex
  startTime: number
  endTime?: number
  /** The bridge call, to tell a sped-up resend of it from a cancel. */
  call?: { to: Address; data: Hex }
  /** The bridge call's nonce, as the origin chain reports it. */
  nonce?: number
  /** The sender's pending nonce read before the send; unchecked, so it only finds the call. */
  nonceHint?: number
  /** ms; the quote's expiry, after which the bridge call reverts on the origin chain. */
  quoteExpiresAt?: number
  /** Rebuilt from the chain on this device: another device sent it. */
  replayed?: true
  /** Set when the bridge pays someone else's deposit address. */
  pays?: BridgeInPays
}

export const BRIDGE_IN_TERMINAL: readonly BridgeInRecord["status"][] = [
  "filled",
  "refunded",
  "expired",
  "failed",
]
