/**
 * Which accepted token funds a SIPA. Mainnet SIPAs take DAI, USDC or USDT and swap into DAI at
 * sweep time, so every reader of a SIPA's funding — the deposit rail, the registration tick, the
 * manual sweep — asks here and gets the same answer.
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

/** Multiplier from `sent` base units into `feeToken` base units. */
export function feeScale(feeToken: SipaFundingToken, sent: SipaFundingToken): bigint {
  return 10n ** BigInt(Math.max(feeToken.decimals - sent.decimals, 0))
}

/** The least `feeToken` a `scaledBalance` of `sent` settles into: parity, less the swap's allowed loss. */
export function settledBalance(
  feeToken: SipaFundingToken,
  sent: SipaFundingToken,
  scaledBalance: bigint,
): bigint {
  if (sameToken(feeToken, sent)) return scaledBalance
  return (scaledBalance * (10_000n - SIPA_SWAP_MAX_SLIPPAGE_BPS)) / 10_000n
}

/**
 * The token a sweep of `sipa` takes: the first sweepable one in list order, otherwise the largest
 * balance in fee-token units, so dust in one token never hides funding in another. `accepted`
 * narrows `sweepable` to a schedule's floor. An unpriced floor (`decided: false`) makes `sweepable`
 * meaningless, so the largest balance wins. Every token is read at once: a slow read of one never
 * delays a deposit that already shows in another, and a failed read of one never hides a sweepable
 * balance in another; it is rethrown only when no token answers the sweep.
 */
export async function readSipaFunding(
  publicClient: PublicClient,
  params: {
    sipa: Address
    feeToken: SipaFundingToken
    fundingTokens: readonly SipaFundingToken[]
    fee: bigint
    fpcFundingCut: bigint
    accepted?: (scaledBalance: bigint, token: SipaFundingToken) => boolean
    decided?: boolean
    /** Balances already read, keyed by lowercased token; a missing one is read here. */
    balances?: ReadonlyMap<string, bigint>
  },
): Promise<SipaFunding> {
  const decided = params.decided ?? true
  // Balances scale up into the fee token's units; a token with more decimals would rank by raw size.
  const wider = params.fundingTokens.find((t) => t.decimals > params.feeToken.decimals)
  if (wider) throw new Error(`${wider.symbol} has more decimals than the fee token`)
  const read = async (token: SipaFundingToken): Promise<SipaFunding> => {
    const status = await readSipaFundingStatus(publicClient as never, {
      sipa: params.sipa as never,
      token: token.address as never,
      fee: params.fee,
      fpcFundingCut: params.fpcFundingCut,
      balanceScale: feeScale(params.feeToken, token),
      balance: params.balances?.get(token.address.toLowerCase()),
    })
    const refused =
      status.sweepable && params.accepted && !params.accepted(status.scaledBalance, token)
    return { token, status: refused ? { ...status, sweepable: false } : status }
  }
  const others = params.fundingTokens.filter((token) => !sameToken(token, params.feeToken))
  const reads = await Promise.allSettled([params.feeToken, ...others].map(read))
  const answers = reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
  const sweepable = decided ? answers.find((answer) => answer.status.sweepable) : undefined
  if (sweepable) return sweepable
  const failed = reads.find((r) => r.status === "rejected")
  if (failed) throw failed.reason
  return answers.reduce((best, next) =>
    next.status.scaledBalance > best.status.scaledBalance ? next : best,
  )
}

/** The largest of `balances` (keyed by lowercased token) across `tokens`, in `feeToken` units. */
export function largestBalance(
  balances: ReadonlyMap<string, bigint>,
  feeToken: SipaFundingToken,
  tokens: readonly SipaFundingToken[],
): bigint {
  return tokens.reduce((max, token) => {
    const scaled = (balances.get(token.address.toLowerCase()) ?? 0n) * feeScale(feeToken, token)
    return scaled > max ? scaled : max
  }, 0n)
}

/** Which of `tokens` holds `sipa`'s funds, by balance alone; `tokens[0]` is the fee token. */
export function readSipaHolding(
  publicClient: PublicClient,
  sipa: Address,
  tokens: readonly [SipaFundingToken, ...SipaFundingToken[]],
): Promise<SipaFunding> {
  return readSipaFunding(publicClient, {
    sipa,
    feeToken: tokens[0],
    fundingTokens: tokens,
    fee: 0n,
    fpcFundingCut: 0n,
    decided: false,
  })
}

/** `sipa`'s largest balance across `tokens`, in `tokens[0]` (fee-token) units. */
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
