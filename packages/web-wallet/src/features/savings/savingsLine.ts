import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { holdingCatalog, type DeploymentHoldings } from "@obsidion/core/oxide"
import {
  assetUsd,
  balanceScope,
  balanceToMove,
  derived,
  memoryStore,
  holdingEarned,
  holdingEarnedPending,
  holdingLedger,
  holdingValue,
  lineMoves,
  savingsHoldings,
  selectHoldings,
  type BackupRotationRecord,
  type BalanceEntry,
  type HoldingLine,
  type HoldingLedger,
  type HoldingPrice,
  type LedgerBurn,
  type MoveRecord,
  type QueryState,
  type ReadonlyStore,
  type RecordSet,
  type SavingsDirection,
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

/** One line's shares, valued at its own vault's price. */
export interface SavingsLineFigures {
  line: HoldingLine
  /** The line's price; undefined until read, and when its read failed with none kept. */
  price?: SavingsPrice
  /** The shares held; undefined until the balance store reads them. */
  shares?: bigint
  /** Null until the shares and their price are read. */
  position: SavingsPosition | null
  /** What the line's moves say its shares cost. */
  ledger: HoldingLedger
}

/** The account's Savings: every line it can move into or holds shares of, on any rail. */
export interface SavingsLine {
  /** The profile's lines in its order, then each unlisted one the account holds, exit-only. */
  lines: readonly SavingsLineFigures[]
  /** Every line's shares are read and the first price read has answered, with a price or not. */
  hydrated: boolean
  /**
   * When the balance store last read each of the deployment's holdings' shares, by holding id. A
   * holding without a line keeps its read, so a claim into a line since emptied stays read.
   */
  sharesReadAt: ReadonlyMap<string, number>
}

/** A visitor's: it holds no Savings. */
export const NO_SAVINGS: ReadonlyStore<SavingsLine> = memoryStore<SavingsLine>({
  lines: [],
  hydrated: false,
  sharesReadAt: new Map(),
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

/** Whether the wallet lists a holding: what offers Savings to an account that holds no shares. */
export function selectSavingsListed(
  holdings: QueryState<DeploymentHoldings>,
  listed: readonly string[] | undefined,
): boolean {
  const deployment = ready(holdings)
  return !!deployment && holdingCatalog(deployment, listed).holdings.length > 0
}

/** The account's lines and their figures, from what is already read. */
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
  const held =
    deployment && scope !== undefined
      ? selectHoldings(holdingCatalog(deployment, listed), deployment, balances, scope)
      : []
  const byId = new Map<string, LedgerBurn>(burns.map((b) => [b.localId, b]))
  const entryOf = (holding: { l2Token: string }) => {
    const token = holding.l2Token.toLowerCase()
    return balances.records.find((e) => e.scope === scope && e.token.toLowerCase() === token)
  }
  const lines = held.map((line): SavingsLineFigures => {
    const token = line.l2Token.toLowerCase()
    const read = ready(prices)?.find((p) => p.holding.l2Token.toLowerCase() === token)
    const price = read && !("failed" in read) ? read : undefined
    const entry = entryOf(line)
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
    const ledger = holdingLedger(lineMoves(moves, line.holdingIds), byId)
    return {
      line,
      ...(price ? { price } : {}),
      ...(entry ? { shares: entry.atomic } : {}),
      position,
      ledger,
    }
  })
  return {
    lines,
    hydrated:
      prices.status !== "pending" && lines.length > 0 && lines.every((l) => l.shares !== undefined),
    sharesReadAt: new Map(
      (deployment?.holdings ?? []).flatMap((holding) => {
        const at = entryOf(holding)?.readAt
        return at === undefined ? [] : [[holding.id, at] as const]
      }),
    ),
  }
}

/** A position's value as read, at `DEFAULT_DECIMALS`. */
const usdAsRead = (position: SavingsPosition): bigint => assetUsd(position.value, position)

/**
 * What Savings is worth, at `DEFAULT_DECIMALS`: every line's shares at their own vault's price,
 * each valued by `usdOf`. Undefined until every line's shares are read and one line is priced, and
 * while a line with shares is unpriced, since its shares must never count as nothing.
 */
export function savingsTotal(savings: SavingsLine, usdOf = usdAsRead): bigint | undefined {
  let total: bigint | undefined
  for (const { shares, position } of savings.lines) {
    if (position) total = (total ?? 0n) + usdOf(position)
    else if (shares !== 0n) return undefined
  }
  return total
}

/**
 * What Savings has earned, at `DEFAULT_DECIMALS`: each line's value less what its shares cost, plus
 * what `usdOf` adds to the value read. Unknown while the total or a line's cost is, and with no
 * shares held and no move counted.
 */
export function selectSavingsEarned(savings: SavingsLine, usdOf = usdAsRead): bigint | undefined {
  if (savingsTotal(savings) === undefined) return undefined
  const idle = ({ shares, ledger }: SavingsLineFigures) => !shares && ledger.counted === 0
  if (savings.lines.every(idle)) return undefined
  let earned = 0n
  for (const { position, ledger } of savings.lines) {
    // A line without a position holds no shares here: the total is unknown otherwise.
    const { value = 0n, shares = 0n, shareDecimals = 0 } = position ?? {}
    const own = holdingEarned(ledger, value, shares, shareDecimals)
    if (own === undefined) return undefined
    if (position) earned += assetUsd(own, position) + usdOf(position) - usdAsRead(position)
  }
  return earned
}

/** Whether Earned waits on a burn the wallet has not yet seen mined. */
export const selectEarnedPending = (savings: SavingsLine): boolean =>
  savings.lines.some(({ ledger }) => holdingEarnedPending(ledger))

const leftOut = (ledger: HoldingLedger) =>
  ledger.excluded.map((e) => `${e.moveId} (${e.reason})`).join(", ")

/** For the console: each line whose counted moves do not add up to its shares, and why. */
export function ledgerNote(savings: SavingsLine): string | undefined {
  const notes = savings.lines.flatMap(({ line, position, ledger }) =>
    position && (ledger.shares !== position.shares || ledger.excluded.length > 0)
      ? [
          `${line.id}: the counted moves add up to ${ledger.shares} shares, ${position.shares} held` +
            (ledger.excluded.length ? `; left out: ${leftOut(ledger)}` : ""),
        ]
      : [],
  )
  return notes.length ? notes.join("; ") : undefined
}

/** For the console: what Earned is worked out from, line by line. */
export const earnedInputsNote = (savings: SavingsLine): string =>
  `hydrated=${savings.hydrated}` +
  savings.lines
    .map(
      ({ line, shares, position, ledger }) =>
        `; ${line.id}: ${shares ?? "unread"} shares, value ${position?.value ?? "none"}, ledger ` +
        `counted ${ledger.counted}, shares ${ledger.shares}, basis ${ledger.basis}, ` +
        `excluded [${leftOut(ledger)}]`,
    )
    .join("")

/**
 * The rate Savings shows: the rates of the lines with shares or funds arriving, weighted by value
 * plus `arriving` (dollars by holding id), leaving out a line without a price or a rate. None while
 * nothing is held or arriving: no one vault's rate is the account's.
 */
export function selectSavingsRate(
  savings: SavingsLine,
  arriving: ReadonlyMap<string, bigint> = new Map(),
): bigint | undefined {
  let weight = 0n
  let weighted = 0n
  let first: bigint | undefined
  for (const { line, shares, position, price } of savings.lines) {
    const coming = line.holdingIds.reduce((sum, id) => sum + (arriving.get(id) ?? 0n), 0n)
    if ((!shares && coming === 0n) || price?.rate === undefined) continue
    first ??= price.rate
    const value = (position ? usdAsRead(position) : 0n) + coming
    weight += value
    weighted += value * price.rate
  }
  // Shares worth nothing weigh nothing: their line's rate stands.
  return weight > 0n ? weighted / weight : first
}

/** The line a move in goes to: the first the profile lists. */
export const moveInLine = (savings: SavingsLine): SavingsLineFigures | undefined =>
  savings.lines.find(({ line }) => !line.exitOnly)

/**
 * The holding a deposit swept on each L1 token lands in, by that token in lowercase: every holding
 * Savings prices, in the profile's order. Undefined until the deployment is read.
 */
export function selectSavingsTokens(
  holdings: QueryState<DeploymentHoldings>,
  listed: readonly string[] | undefined,
): ReadonlyMap<string, string> | undefined {
  const deployment = ready(holdings)
  if (!deployment) return undefined
  const tokens = new Map<string, string>()
  for (const holding of savingsHoldings(deployment, listed)) {
    const token = holding.held.underlying.toLowerCase()
    if (!tokens.has(token)) tokens.set(token, holding.id)
  }
  return tokens
}

/**
 * The shares a backup passkey add has yet to move into the account at `address`, by the holding of
 * each line that still waits for some.
 */
export const selectBackupShares = (
  lines: readonly SavingsLineFigures[],
  rotations: readonly BackupRotationRecord[],
  address: string | undefined,
): ReadonlyMap<string, bigint> =>
  new Map(
    lines.flatMap(({ line, position }) => {
      const owed = balanceToMove(rotations, address, position?.sharesToken, position?.sharesAnchor)
      return owed > 0n ? [[line.id, owed] as const] : []
    }),
  )

/** Shares worth less cannot pay for a move. */
const CENT = 10n ** BigInt(DEFAULT_DECIMALS - 2)

type PricedLine = SavingsLineFigures & { position: SavingsPosition }

/**
 * The line a move out starts on. A line the profile no longer lists comes first, so it empties;
 * one holding under a cent passes to the next, as no move can carry it. An unpriced line is passed
 * over: its shares cannot be sized. Undefined while no line is priced.
 */
export function moveOutSource(savings: SavingsLine): PricedLine | undefined {
  const priced = savings.lines.filter((l): l is PricedLine => l.position !== null)
  const listed = priced.filter(({ line }) => !line.exitOnly)
  const lines = [...priced.filter(({ line }) => line.exitOnly), ...listed]
  return lines.find(({ position }) => usdAsRead(position) >= CENT) ?? listed[0] ?? lines[0]
}

/**
 * The line a move uses: the one picked, or none when it cannot take the move, as a line the profile
 * no longer lists takes no move in. With nothing picked, a move in's first listed line, or the line
 * `moveOutSource` empties first.
 */
export function moveLine(
  savings: SavingsLine,
  direction: SavingsDirection,
  picked?: string,
): SavingsLineFigures | undefined {
  if (picked === undefined)
    return direction === "in" ? moveInLine(savings) : moveOutSource(savings) ?? savings.lines[0]
  const asked = savings.lines.find(({ line }) => line.id === picked)
  return direction === "in" && asked?.line.exitOnly ? undefined : asked
}

/** The lines a move can go through: listed ones going in, those with shares going out. */
export const moveLines = (savings: SavingsLine, direction: SavingsDirection) =>
  savings.lines.filter(({ line, shares }) =>
    direction === "in" ? !line.exitOnly : (shares ?? 0n) > 0n,
  )

/**
 * Whether shares of a line can swap into another vault: of `holdingId`'s line, or of any line.
 * What names a move out "Move funds".
 */
export const selectVaultSwappable = (
  savings: SavingsLine,
  targets: ReadonlyMap<string, readonly string[]>,
  holdingId?: string,
): boolean =>
  moveLines(savings, "out").some(
    ({ line }) =>
      (holdingId === undefined || line.id === holdingId) && (targets.get(line.id)?.length ?? 0) > 0,
  )

/** The session's Savings, rebuilt as its holdings, prices, shares and moves change. */
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
