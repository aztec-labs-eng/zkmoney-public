import { erc20Abi, formatUnits, parseUnits, type Address } from "viem"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import { tokenMetadata } from "../sipa/loadDepositFacts"

export type L1TokenBalance = {
  /** Raw ERC-20 units. */
  raw: bigint
  /** Display units as a number (for form comparisons). */
  value: number
  /** `${formatted} ${symbol}` — exact, never rounded up. */
  display: string
  symbol: string
  decimals: number
}

/** Expected shortfall — form gate should catch this; gateway re-checks before the wallet prompt. */
export class InsufficientL1BalanceError extends Error {
  readonly balance: L1TokenBalance
  constructor(balance: L1TokenBalance) {
    super(`Not enough ${balance.symbol} — this wallet holds ${balance.display}`)
    this.name = "InsufficientL1BalanceError"
    this.balance = balance
  }
}

/** True when `amountDisplay` parses and exceeds `balance.raw` (same units as the transfer). */
export function amountExceedsBalance(amountDisplay: string, balance: L1TokenBalance): boolean {
  try {
    return parseUnits(amountDisplay.trim(), balance.decimals) > balance.raw
  } catch {
    return false
  }
}

/** Balance of `token` (default: the manifest token) for `account` on the active network's L1. */
export async function readL1DepositTokenBalance(
  account: Address,
  token: Address | undefined,
  { config, chain }: PageFacts,
): Promise<L1TokenBalance> {
  token ??= requireTupleField(await chain.oxideTuple.read(), "token") as Address
  const [raw, { decimals, symbol }] = await Promise.all([
    l1PublicClient(config).readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    }),
    tokenMetadata({ chain }, token),
  ])
  const formatted = formatUnits(raw, decimals)
  return {
    raw,
    value: Number(formatted),
    display: `${formatted} ${symbol}`,
    symbol,
    decimals,
  }
}
