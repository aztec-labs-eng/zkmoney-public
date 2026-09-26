import { createPublicClient, erc20Abi, formatUnits, parseUnits, type Address } from "viem"
import { getConfig, l1Transport } from "../../config/env"
import { getOxideTuple, requireTupleField } from "../../config/oxideTuple"

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

/**
 * `decimals` and `symbol` per token, read once.
 *
 * Both are fixed for the life of an ERC-20, so the only part of a balance read that has to reach
 * L1 again is the balance. Keyed by chain as well as token: the same address on another chain is
 * another contract.
 */
const tokenMetadata = new Map<string, Promise<{ decimals: number; symbol: string }>>()

function readTokenMetadata(
  publicClient: ReturnType<typeof createPublicClient>,
  chainId: number,
  token: Address,
): Promise<{ decimals: number; symbol: string }> {
  const key = `${chainId}:${token.toLowerCase()}`
  let meta = tokenMetadata.get(key)
  if (!meta) {
    meta = Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ]).then(([decimals, symbol]) => ({ decimals, symbol }))
    // A failed read must not be remembered as the token's identity.
    meta.catch(() => tokenMetadata.delete(key))
    tokenMetadata.set(key, meta)
  }
  return meta
}

/** Balance of `token` (default: the manifest token) for `account` on the active network's L1. */
export async function readL1DepositTokenBalance(
  account: Address,
  token?: Address,
): Promise<L1TokenBalance> {
  const config = getConfig()
  const publicClient = createPublicClient({ transport: l1Transport(config) })
  token ??= requireTupleField(await getOxideTuple(config), "token") as Address
  const [raw, { decimals, symbol }] = await Promise.all([
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    }),
    readTokenMetadata(publicClient, config.l1ChainId, token),
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

/** Raw `token` balance of `owner` — how the deposit screen watches the address it handed out. */
export async function readL1TokenBalance(token: Address, owner: Address): Promise<bigint> {
  const publicClient = createPublicClient({ transport: l1Transport(getConfig()) })
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })
}
