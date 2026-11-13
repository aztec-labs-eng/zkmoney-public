import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { holdingCatalog, type DeploymentHoldings } from "@obsidion/core/oxide"
import {
  assetUsd,
  balanceScope,
  derived,
  memoryStore,
  holdingEarned,
  holdingLedger,
  holdingValue,
  selectHoldings,
  type BalanceEntry,
  type HoldingLine,
  type HoldingLedger,
  type HoldingPrice,
  type LedgerBurn,
  type MoveRecord,
  type QueryState,
  type ReadonlyStore,
  type RecordSet,
  type Service,
  type WithdrawalRecord,
  type Loaded,
  WalletError,
} from "@obsidion/front-core"
import type { ObsidionAccount } from "@obsidion/sdk"
import type { Session } from "../../session/session"
import type { PageChain, SavingsPrice, SavingsPriceRead } from "../../session/pageChain"

/** The shares held, valued at the vault's price. */
export interface SavingsPosition {
  shares: bigint
  /** What the shares redeem for, in the vault asset's base units. */
  value: bigint
  /** What one whole share redeems for. */
  sharePrice: bigint
  /** The yearly rate at `RATE_SCALE`; absent when unread. */
  rate?: bigint
  /** When the price was read. */
  readAt: number
  shareDecimals: number
  /** The vault's asset's, which `value` is in. */
  assetDecimals: number
  /** When the balance store last wrote the shares: a claim counts as arriving until then. */
  sharesReadAt?: number
  /** The PXE block the shares were read at; shares moved in a later block are not in them. */
  sharesAnchor?: number
  /** The token the balance store keeps the shares under. */
  sharesToken?: string
}

/** One Sky line's shares, valued at its own vault's price. */
export interface SavingsLineFigures {
  line: HoldingLine
  /** The line's price; undefined until read, and when its read failed with none kept. */
  price?: SavingsPrice
  /** Null until the shares and their price are read. */
  position: SavingsPosition | null
  /** What the line's moves say its shares cost. */
  ledger: HoldingLedger
}

/**
 * The account's Savings: its first Sky line, and every other Sky line it holds shares of. The
 * first is the profile's Sky holding, where a move in goes, or an unlisted one the account holds
 * shares of, exit-only.
 */
export interface SavingsLine extends Partial<SavingsLineFigures> {
  position: SavingsPosition | null
  /**
   * The other Sky lines the account holds shares of, such as a vault the profile no longer lists:
   * each counts in Savings, and its shares can leave.
   */
  others: readonly SavingsLineFigures[]
  /** The first line's shares are read and the first price read has answered, with a price or not. */
  hydrated: boolean
}

/** A visitor's: it holds no Savings. */
export const NO_SAVINGS: ReadonlyStore<SavingsLine> = memoryStore<SavingsLine>({
  position: null,
  others: [],
  hydrated: false,
}).readonly

/** What one whole share of the holding held at `portal` redeems for. */
export async function sharePriceAt(
  chain: Pick<PageChain, "holdings" | "holdingPrice">,
  portal: string,
  signal?: AbortSignal,
): Promise<bigint> {
  const { holdings } = await chain.holdings.read(signal)
  const holding = holdings.find((h) => h.held.portal.toLowerCase() === portal.toLowerCase())
  if (!holding) throw new WalletError("invariant", `no holding is held at ${portal}`)
  return (await chain.holdingPrice(holding).read(signal)).sharePrice
}

const ready = <T>(state: QueryState<T>) => (state.status === "ready" ? state.value : undefined)

/**
 * Each holding's price by id: its own holding's, read by its share token. Absent until read, and
 * for a holding whose price failed or the deployment does not have.
 */
export function selectHoldingPrices(
  holdings: QueryState<DeploymentHoldings>,
  prices: QueryState<readonly SavingsPriceRead[]>,
): ReadonlyMap<string, HoldingPrice> {
  const byToken = new Map(
    (ready(prices) ?? []).flatMap((read) =>
      "failed" in read ? [] : [[read.holding.l2Token.toLowerCase(), read] as const],
    ),
  )
  return new Map(
    (ready(holdings)?.holdings ?? []).flatMap((holding) => {
      const price = byToken.get(holding.l2Token.toLowerCase())
      return price ? [[holding.id, price] as const] : []
    }),
  )
}

/** Whether the wallet lists a Sky holding: what offers Savings to an account that holds no shares. */
export function selectSavingsListed(
  holdings: QueryState<DeploymentHoldings>,
  listed: readonly string[] | undefined,
): boolean {
  const deployment = ready(holdings)
  if (!deployment) return false
  return holdingCatalog(deployment, listed).holdings.some((h) => h.rail === "skyEscrow")
}

/** The account's Sky lines and their figures, from what is already read. */
export function selectSavingsLine(
  listed: readonly string[] | undefined,
  holdings: QueryState<DeploymentHoldings>,
  prices: QueryState<readonly SavingsPriceRead[]>,
  balances: RecordSet<BalanceEntry>,
  scope: string | undefined,
  moves: readonly MoveRecord[],
  burns: readonly WithdrawalRecord[],
): SavingsLine {
  const deployment = ready(holdings)
  const lines =
    deployment && scope !== undefined
      ? selectHoldings(holdingCatalog(deployment, listed), deployment, balances, scope)
      : []
  const byId = new Map<string, LedgerBurn>(burns.map((b) => [b.localId, b]))
  const figures = (line: HoldingLine) => {
    const token = line.l2Token.toLowerCase()
    const read = ready(prices)?.find((p) => p.holding.l2Token.toLowerCase() === token)
    const price = read && !("failed" in read) ? read : undefined
    const entry = balances.records.find((e) => e.scope === scope && e.token.toLowerCase() === token)
    const position: SavingsPosition | null =
      entry && price
        ? {
            shares: entry.atomic,
            value: holdingValue(entry.atomic, price),
            sharePrice: price.sharePrice,
            ...(price.rate === undefined ? {} : { rate: price.rate }),
            readAt: price.readAt,
            shareDecimals: price.shareDecimals,
            assetDecimals: price.assetDecimals,
            ...(entry.readAt === undefined ? {} : { sharesReadAt: entry.readAt }),
            ...(entry.anchor === undefined ? {} : { sharesAnchor: entry.anchor }),
            sharesToken: entry.token,
          }
        : null
    const ledger = holdingLedger(
      moves.filter((m) => line.holdingIds.includes(m.holdingId)),
      byId,
    )
    const own: SavingsLineFigures = {
      line,
      ...(price ? { price } : {}),
      position,
      ledger,
    }
    return { own, shares: entry?.atomic }
  }
  const [first, ...rest] = lines.filter((l) => l.rail === "skyEscrow").map(figures)
  return {
    ...first?.own,
    position: first?.own.position ?? null,
    others: rest.filter((other) => (other.shares ?? 0n) > 0n).map((other) => other.own),
    hydrated: prices.status !== "pending" && first?.shares !== undefined,
  }
}

/** The first line and each other with shares: the lines whose shares Savings holds. */
const fundedLines = (savings: SavingsLine): readonly Pick<SavingsLineFigures, "position">[] => [
  { position: savings.position },
  ...savings.others,
]

/**
 * What Savings is worth: every line's shares at their own vault's price. Undefined while a line
 * with shares is unpriced, since its shares must never count as nothing.
 */
export function savingsTotal(savings: SavingsLine): bigint | undefined {
  let value = 0n
  for (const { position } of fundedLines(savings)) {
    if (!position) return undefined
    value += position.value
  }
  return value
}

/**
 * What the other lines add to the first line's figures: their value at its last read, and what
 * they have earned, unknown while one's cost is. Undefined while one of them is unpriced.
 */
export function selectOtherLines(
  savings: SavingsLine,
): { value: bigint; earned: bigint | undefined } | undefined {
  let value = 0n
  let earned: bigint | undefined = 0n
  for (const { position, ledger } of savings.others) {
    if (!position) return undefined
    value += position.value
    const own = holdingEarned(ledger, position.value, position.shares, position.shareDecimals)
    earned = earned === undefined || own === undefined ? undefined : earned + own
  }
  return { value, earned }
}

/**
 * What Savings has earned with the first line worth `value`: each line's value less what its
 * shares cost. Unknown while a line's cost is, and with no shares held and no move counted.
 */
export function selectSavingsEarned(savings: SavingsLine, value: bigint): bigint | undefined {
  const { ledger, position } = savings
  const others = selectOtherLines(savings)
  if (!ledger || others?.earned === undefined) return undefined
  const shares = position?.shares ?? 0n
  if (shares === 0n && ledger.counted === 0 && savings.others.length === 0) return undefined
  const first = holdingEarned(ledger, value, shares, position?.shareDecimals ?? 18)
  return first === undefined ? undefined : first + others.earned
}

/** Shares worth less cannot pay for a move. */
const CENT = 10n ** BigInt(DEFAULT_DECIMALS - 2)

/**
 * The line a move out of `amount` takes shares from. A line the profile no longer lists comes
 * first, so it empties; one that cannot cover `amount` passes it to the next, so shares too few to
 * move never hold back another line's. An unpriced line is passed over: its shares cannot be
 * sized. Undefined while no line is priced.
 */
export function moveOutSource(
  savings: SavingsLine,
  amount = 0n,
): { line: HoldingLine; position: SavingsPosition } | undefined {
  const priced = ({ line, position }: Partial<Pick<SavingsLineFigures, "line" | "position">>) =>
    line && position ? [{ line, position }] : []
  const others = savings.others.flatMap(priced)
  const first = priced(savings)
  const lines = [
    ...others.filter((other) => other.line.exitOnly),
    ...first,
    ...others.filter((other) => !other.line.exitOnly),
  ]
  const covers = ({ position }: (typeof lines)[number]) => {
    const worth = assetUsd(position.value, position)
    return worth >= CENT && worth >= amount
  }
  return lines.find(covers) ?? first[0] ?? lines[0]
}

/** The session's Savings line, rebuilt as its holdings, price, shares and moves change. */
export function savingsLine(
  session: Pick<Session, "page" | "moves" | "withdrawals">,
  account: Service<ObsidionAccount>,
  balances: { view: ReadonlyStore<RecordSet<BalanceEntry>> },
): ReadonlyStore<SavingsLine> {
  const { page } = session
  return derived(
    [
      page.chain.holdings,
      page.chain.savingsPrices,
      balances.view,
      account,
      session.moves.view,
      session.withdrawals.list,
    ] as const,
    (holdings, price, balances, owner, moves, burns: Loaded<WithdrawalRecord>) =>
      selectSavingsLine(
        page.config.holdings,
        holdings,
        price,
        balances,
        owner.status === "ready"
          ? balanceScope(page.config.network, owner.value.getCompleteAddress().toString())
          : undefined,
        moves.records,
        burns.records,
      ),
  )
}
