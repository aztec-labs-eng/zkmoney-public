/**
 * Which accepted token funds a SIPA, each priced on the row its sweep settles on. A SIPA accepts every
 * row's token, and on mainnet swaps USDC and USDT into DAI at sweep time, so every reader of a
 * SIPA's funding — the deposit rail, the registration tick, the manual sweep — asks here and gets
 * the same answer.
 */
import { zeroAddress, type Address, type Hash, type PublicClient } from "viem"
import { SIPA_SWAP_MAX_SLIPPAGE_BPS } from "@obsidion/core/constants"
import {
  readSipaFundingStatus,
  type SipaFundingStatus,
  type SipaFundingTransfer,
  type TokenTransfer,
} from "@obsidion/sdk"

/** An L1 ERC-20 a SIPA can be funded with. */
export interface SipaFundingToken {
  address: Address
  symbol: string
  decimals: number
}

/**
 * ETH sent to a SIPA. No sweep moves it, so `recoverETH` is its only exit; the zero address is the
 * contract's own name for it (`Recovered(address(0), …)`).
 */
export const NATIVE_ETH: SipaFundingToken = { address: zeroAddress, symbol: "ETH", decimals: 18 }

export const isNativeEth = (address: string | undefined): boolean =>
  address?.toLowerCase() === zeroAddress

/** A SIPA's funding in the token that carries it. */
export interface SipaFunding {
  token: SipaFundingToken
  status: SipaFundingStatus
}

const sameToken = (a: SipaFundingToken, b: SipaFundingToken) =>
  a.address.toLowerCase() === b.address.toLowerCase()

/**
 * `amount` of `sent` in units of `row`, the row token it swaps into. The swap is a stablecoin
 * parity trade (mainnet USDC and USDT into DAI), so only the decimals differ.
 */
export function inRowUnits(amount: bigint, sent: SipaFundingToken, row: SipaFundingToken): bigint {
  const shift = row.decimals - sent.decimals
  return shift >= 0 ? amount * 10n ** BigInt(shift) : amount / 10n ** BigInt(-shift)
}

/** The least `row` token an `amount` of `sent`, in row units, settles into: parity, less the swap's allowed loss. */
export function settledBalance(
  row: SipaFundingToken,
  sent: SipaFundingToken,
  amount: bigint,
): bigint {
  if (sameToken(row, sent)) return amount
  return (amount * (10_000n - SIPA_SWAP_MAX_SLIPPAGE_BPS)) / 10_000n
}

/** A token a SIPA may hold, priced on the row its sweep settles on. */
export interface SipaFundingRoute {
  token: SipaFundingToken
  /** The row's token, which `fee` and `txAmountCap` are in; `token` itself unless the SIPA swaps it. */
  settlesIn?: SipaFundingToken
  /** The row's sweep fee for the SIPA's intent. */
  fee: bigint
  /** The row portal's `TX_AMOUNT_CAP()`. */
  txAmountCap: bigint
}

/** A balance in its row's units, comparable across rows of different decimals. */
const comparable = (funding: SipaFunding & { settlesIn: SipaFundingToken }) =>
  funding.status.scaledBalance * 10n ** BigInt(Math.max(36 - funding.settlesIn.decimals, 0))

/**
 * The token a sweep of `sipa` takes: the first sweepable route in list order, otherwise the
 * largest balance, so dust in one token never hides funding in another. Each route's window is its
 * own row's fee and cap, in that row's units. `accepted` narrows `sweepable` to a schedule's floor.
 * An unpriced floor (`decided: false`) makes `sweepable` meaningless, so the largest balance wins.
 * Every token is read at once: a slow read of one never delays a deposit that already shows in
 * another, and a failed read of one never hides a sweepable balance in another; it is rethrown
 * only when no token answers the sweep.
 */
export async function readSipaFunding(
  publicClient: PublicClient,
  params: {
    sipa: Address
    routes: readonly SipaFundingRoute[]
    accepted?: (rowBalance: bigint, token: SipaFundingToken) => boolean
    decided?: boolean
    /** Balances already read, keyed by lowercased token; a missing one is read here. */
    balances?: ReadonlyMap<string, bigint>
  },
): Promise<SipaFunding> {
  if (!params.routes.length) throw new Error("A SIPA funding read needs at least one token")
  const decided = params.decided ?? true
  const read = async (route: SipaFundingRoute) => {
    const settlesIn = route.settlesIn ?? route.token
    const shift = settlesIn.decimals - route.token.decimals
    if (shift < 0) throw new Error(`${route.token.symbol} swaps into a token of fewer decimals`)
    const status = await readSipaFundingStatus(publicClient as never, {
      sipa: params.sipa as never,
      token: route.token.address as never,
      fee: route.fee,
      txAmountCap: route.txAmountCap,
      balanceScale: 10n ** BigInt(shift),
      balance: params.balances?.get(route.token.address.toLowerCase()),
    })
    const refused =
      status.sweepable && params.accepted && !params.accepted(status.scaledBalance, route.token)
    return {
      token: route.token,
      settlesIn,
      status: refused ? { ...status, sweepable: false } : status,
    }
  }
  const reads = await Promise.allSettled(params.routes.map(read))
  const answers = reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
  const sweepable = decided ? answers.find((answer) => answer.status.sweepable) : undefined
  const failed = reads.find((r) => r.status === "rejected")
  if (!sweepable && failed) throw failed.reason
  const best =
    sweepable ?? answers.reduce((best, next) => (comparable(next) > comparable(best) ? next : best))
  return { token: best.token, status: best.status }
}

/**
 * Which of `tokens` holds `sipa`'s funds, by balance alone. `tokens[0]` is the row token the
 * others swap into, and the balance is in its units.
 */
export function readSipaHolding(
  publicClient: PublicClient,
  sipa: Address,
  tokens: readonly [SipaFundingToken, ...SipaFundingToken[]],
): Promise<SipaFunding> {
  return readSipaFunding(publicClient, {
    sipa,
    // Undecided: `sweepable` is not read, so no fee or cap applies.
    routes: tokens.map((token) => ({ token, settlesIn: tokens[0], fee: 0n, txAmountCap: 0n })),
    decided: false,
  })
}

/** `sipa`'s largest balance across `tokens`, in `tokens[0]` units; see {@link readSipaHolding}. */
export async function readSipaBalance(
  publicClient: PublicClient,
  sipa: Address,
  tokens: readonly [SipaFundingToken, ...SipaFundingToken[]],
): Promise<bigint> {
  return (await readSipaHolding(publicClient, sipa, tokens)).status.scaledBalance
}

/** The earliest of `perToken[i]`, the transfers of `fundingTokens[i]` into one SIPA. */
export function firstFunding(
  perToken: readonly SipaFundingTransfer[][],
  fundingTokens: readonly SipaFundingToken[],
): { transfer: SipaFundingTransfer; token: SipaFundingToken } | undefined {
  let first: { transfer: SipaFundingTransfer; token: SipaFundingToken } | undefined
  // List order breaks a tie on block number.
  perToken.forEach((transfers, i) => {
    const transfer = transfers[0]
    if (transfer && (!first || transfer.blockNumber < first.transfer.blockNumber))
      first = { transfer, token: fundingTokens[i] }
  })
  return first
}

/** What a sweep took out of a SIPA: the token, and every funding transfer of it the sweep settled. */
export interface SweptFunding {
  token: SipaFundingToken
  gross: bigint
}

/**
 * Which of `fundingTokens` the sweep `txHash` moved out of its SIPA, and how much: what its funder
 * had sent. `outflows` are the SIPA's transfers out. Undefined when the tx moved more than one of
 * them out, since a batched tx can carry several sweeps of one SIPA and the logs do not say which
 * token each took.
 */
export function sweptFunding(
  outflows: readonly TokenTransfer[],
  txHash: Hash,
  fundingTokens: readonly SipaFundingToken[],
): SweptFunding | undefined {
  const out = new Map<string, bigint>()
  for (const flow of outflows) {
    if (flow.txHash.toLowerCase() !== txHash.toLowerCase()) continue
    const token = flow.token.toLowerCase()
    out.set(token, (out.get(token) ?? 0n) + flow.value)
  }
  const swept = fundingTokens.filter((t) => out.has(t.address.toLowerCase()))
  const token = swept.length === 1 ? swept[0] : undefined
  return token ? { token, gross: out.get(token.address.toLowerCase())! } : undefined
}
