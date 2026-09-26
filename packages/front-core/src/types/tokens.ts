import { FaucetAction } from "./transactions"

export type Token = {
  address: string
  name: string
  symbol: string
  decimals: number
  logo?: string
}

export type Asset = {
  name: string
  symbol: string
  address: string
  decimals: number
  balance: number
  // Exact base-unit balance; `balance` is a lossy Number for display only.
  balanceAtomic: bigint
  publicBalance: number
  privateBalance: number
  price: number
  change: number
  changeAmount: number
  logo: string
}

export type TokenInTxService = {
  address: string
  name: string
  symbol: string
  decimals: number
  logo: string
  amount: number
  price: number
  hasUnknownAmount?: boolean
}

export type TokenAction = "send" | "receive"

// PaylinkAction (formerly EmailPaymentAction) — stored values unchanged for
// back-compat with persisted rows; the email-specific labels predate direct
// paylinks. Direct vs email is now distinguished by the row's flavor field
// (see types/transactions.ts), not by separate action strings.
export type PaylinkAction =
  | "Pay To Email"
  | "Claim With Email"
  | "Claim Back"
  | "Refunded"
  | "Claimed"

export type Action = PaylinkAction | TokenAction | FaucetAction
