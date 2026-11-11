// What a holding line's shares are worth and earn: the vault's share price and rate, read on L1,
// the shares the wallet's sync keeps in the balance store, and the cost of those shares from the
// moves.
import { bestEffort } from "@obsidion/core/errors"
import type { Holding } from "@obsidion/core/oxide"
import { erc20Abi, erc4626Abi } from "viem"
import type { Address, PublicClient } from "viem"
import type { BalanceEntry } from "../../../engine/balances"
import { holdingEarned, holdingEarnedPending, holdingLedger } from "../../../engine/holdingLedger"
import type { LedgerBurn, LedgerMove } from "../../../engine/holdingLedger"
import { heldShares } from "../../../engine/holdings"
import type { HoldingLine } from "../../../engine/holdings"
import type { RecordSet } from "../../../engine/persistentStore"
import type { QueryEntry, QueryFactory, QueryState } from "../../../engine/query"
import { makeLimiter } from "../../../utils/makeLimiter"

export type HoldingsL1 = Pick<PublicClient, "readContract" | "getBlockNumber">

/** A rate of `RATE_SCALE` is 100% a year. */
export const RATE_SCALE = 10n ** 18n

/** The vault's side of a holding, read on L1. */
export interface HoldingPrice {
  /** What one whole share redeems for, in the vault asset's base units. */
  sharePrice: bigint
  shareDecimals: number
  /** The yearly yield in `RATE_SCALE`; absent before the chain is a window old, or when unread. */
  rate?: bigint
  readAt: number
}

/** How often a holding's price is read while something shows it. */
export const HOLDING_PRICE_EVERY_MS = 60_000
/** Holdings read at once: a few calls each, never one burst. */
const HOLDINGS_AT_ONCE = 3
/** A 52nd of a 365.25-day year in 12 s blocks: the rate compounds the window's growth 52 times. */
export const RATE_WINDOW_BLOCKS = 50_573n
const WINDOWS_PER_YEAR = 52

/** The yearly rate of a share price that grew from `then` to `now` over one window. */
export function yearlyRate(now: bigint, then: bigint): bigint {
  const growth = (now * RATE_SCALE) / then
  let year = RATE_SCALE
  for (let i = 0; i < WINDOWS_PER_YEAR; i++) year = (year * growth) / RATE_SCALE
  return year - RATE_SCALE
}

/** What `shares` redeem for at `price`, in the vault asset's base units. */
export const holdingValue = (shares: bigint, price: HoldingPrice): bigint =>
  (shares * price.sharePrice) / 10n ** BigInt(price.shareDecimals)

/**
 * Each holding's price, keyed by its vault: read when a view subscribes, every minute while it
 * does, and by a task's `read()` once a minute old. A pass reads the L1 head once, and per holding
 * the latest share price and the price a window before that head, three holdings at a time; the
 * share's decimals are read once. Only the earlier read is pinned, so a node a block behind still
 * prices the holding.
 */
export function holdingPrices(
  query: QueryFactory,
  l1: HoldingsL1,
  now: () => number,
): (holding: Pick<Holding, "held">) => QueryEntry<HoldingPrice> {
  const limit = makeLimiter(HOLDINGS_AT_ONCE)
  // Half the price's period, so every price of one pass shares a head and the next pass reads anew.
  const head = query<[], bigint>("holdingsHead", {
    load: () => l1.getBlockNumber({ cacheTime: 0 }),
    stale: HOLDING_PRICE_EVERY_MS / 2,
  })()
  const decimals = query<[vault: string], number>("holdingShareDecimals", {
    load: (vault) =>
      l1.readContract({ address: vault as Address, abi: erc20Abi, functionName: "decimals" }),
  })
  const price = query<[vault: string], HoldingPrice>("holdingPrice", {
    load: (vault, signal) =>
      limit(async () => {
        const [at, shareDecimals] = await Promise.all([
          head.read(signal),
          decimals(vault).read(signal),
        ])
        const unit = 10n ** BigInt(shareDecimals)
        const priceAt = (blockNumber?: bigint) =>
          l1.readContract({
            address: vault as Address,
            abi: erc4626Abi,
            functionName: "convertToAssets",
            args: [unit],
            ...(blockNumber === undefined ? {} : { blockNumber }),
          })
        const [sharePrice, then] = await Promise.all([
          priceAt(),
          at > RATE_WINDOW_BLOCKS
            ? bestEffort("holding.rateUnread", priceAt(at - RATE_WINDOW_BLOCKS))
            : undefined,
        ])
        return {
          sharePrice,
          shareDecimals,
          ...(then !== undefined && then > 0n ? { rate: yearlyRate(sharePrice, then) } : {}),
          readAt: now(),
        }
      }),
    poll: HOLDING_PRICE_EVERY_MS,
    stale: HOLDING_PRICE_EVERY_MS,
  })
  return (holding) => price(holding.held.underlying)
}

export interface HoldingFigures {
  /** Undefined until the balance store holds a read of the line's token. */
  shares?: bigint
  rate?: bigint
  /** What the shares redeem for, in the vault asset's base units. */
  value?: bigint
  /** `value` less what the shares cost; undefined while unknown. */
  earned?: bigint
  /** `earned` is unknown only until the burns it waits on are seen mined. */
  earnedPending: boolean
}

/**
 * A line's figures. `moves` may hold any holding's: the line counts those of its token's holdings.
 * A price kept through a failed read still values the shares.
 */
export function selectHoldingFigures(
  line: Pick<HoldingLine, "l2Token" | "holdingIds">,
  price: QueryState<HoldingPrice>,
  balances: RecordSet<BalanceEntry>,
  scope: string,
  moves: readonly LedgerMove[],
  burns: ReadonlyMap<string, LedgerBurn>,
): HoldingFigures {
  const shares = heldShares(balances, scope, line.l2Token)
  const read = price.status === "ready" ? price.value : undefined
  const value = shares !== undefined && read ? holdingValue(shares, read) : undefined
  const ledger = holdingLedger(
    moves.filter((m) => line.holdingIds.includes(m.holdingId)),
    burns,
  )
  const earned =
    shares !== undefined && value !== undefined && read
      ? holdingEarned(ledger, value, shares, read.shareDecimals)
      : undefined
  return {
    ...(shares === undefined ? {} : { shares }),
    ...(read?.rate === undefined ? {} : { rate: read.rate }),
    ...(value === undefined ? {} : { value }),
    ...(earned === undefined ? {} : { earned }),
    earnedPending: holdingEarnedPending(ledger),
  }
}
