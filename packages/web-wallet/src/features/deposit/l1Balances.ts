import type { Query, QueryFactory } from "@obsidion/front-core"
import type { Address } from "viem"
import type { L1TokenBalance } from "./l1DepositTokenBalance"

/** Funds can arrive from another tab or app, such as a faucet mint, while the form is open. */
const L1_BALANCE_REFRESH_MS = 15_000

type Key = [account: Address, token: Address | undefined]

/** A wallet's L1 balance of a token; no token means the manifest token, the zero address ETH. */
export type L1Balances = Query<Key, L1TokenBalance>

/** The L1 balances the deposit form caps its amount at, read again while subscribed. */
export function l1Balances(
  query: QueryFactory,
  read: (account: Address, token: Address | undefined) => Promise<L1TokenBalance>,
): L1Balances {
  return query<Key, L1TokenBalance>("l1TokenBalance", {
    load: (account, token) => read(account, token),
    poll: L1_BALANCE_REFRESH_MS,
    stale: L1_BALANCE_REFRESH_MS,
  })
}
