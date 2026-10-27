import { balanceScope, type BalanceRecord } from "src/core/storages/BalanceStorage"
import type { BalanceSync } from "src/core/services/transactions/bootPriority"
import { isWalletTokenSymbol } from "src/utils/tokenIdentity"
import type { Sourced } from "./legacyStore"
import { memoryStore, derived, type ReadonlyStore } from "./store"

/** One stored balance; `readAt` is wall-clock ms the read resolved, `updatedAt` of the write. */
export interface BalanceEntry {
  scope: string
  token: string
  atomic: bigint
  anchor?: number
  readAt?: number
  updatedAt?: number
}

/**
 * Which records are Main's: the live scope, the token rows, its address once known. The active
 * address names its row whatever the row's symbol; before it resolves, the symbol picks candidates.
 */
export interface WalletTokens {
  scope: string
  tokens: readonly { address: string; decimals: number }[]
  active: string | null
  /** The active token row's decimals are not yet checked against its immutables. */
  decimalsPending: boolean
}

export interface BalanceRecords {
  /** The persisted records were read, or the read failed. */
  hydrated: boolean
  entries: readonly BalanceEntry[]
}

export interface BalanceView {
  /**
   * Main's balance, or null when none above zero can be told apart. Before the token address
   * resolves only a lone candidate counts: guessing could pin a stale balance on screen.
   */
  main: { atomic: bigint; decimals: number } | null
  /** A read from this session landed. Spend checks trust only this, never the cache. */
  live: boolean
  /**
   * The figure may replace the placeholder: a live read, even of nothing, or a cached figure whose
   * row is clear. Never an ambiguous cache, which would show a confident $0. While the boot sync
   * runs only a live read counts: a cached figure can be high, and the pill says it can only climb.
   */
  known: boolean
  syncing: boolean
  progress: number | null
  /** When Main's balance was last written; funds on their way count until then. */
  readAt: number | undefined
}

export interface BalanceSource {
  load(): Promise<void>
  list(): BalanceRecord[]
  onListChanged(listener: (records: BalanceRecord[]) => void): () => void
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

type AccountRow = { completeAddress: string } | undefined
type TokenRows = readonly { address: string; symbol: string; decimals: number }[]

/** What names Main's records. */
export interface WalletSources {
  /** The session's network type; null before it is known. */
  network: string | null
  account: ReadonlyStore<Sourced<AccountRow>>
  tokens: ReadonlyStore<Sourced<TokenRows>>
  /** The live token address, or null before it resolves. */
  active: ReadonlyStore<string | null>
  /** The active token row's decimals are not yet checked against its immutables. */
  decimalsPending: ReadonlyStore<boolean>
}

export interface Balances {
  records: ReadonlyStore<BalanceRecords>
  view: ReadonlyStore<BalanceView>
}

function toEntry(r: BalanceRecord): BalanceEntry[] {
  try {
    const atomic = BigInt(r.balance)
    return [
      {
        scope: r.scope,
        token: r.tokenAddress,
        atomic,
        anchor: r.anchorBlock,
        readAt: r.readAt ?? r.updatedAt,
        updatedAt: r.updatedAt,
      },
    ]
  } catch {
    return [] // the decode boundary: a corrupt record is skipped, not the others
  }
}

export function selectEntry(
  records: BalanceRecords,
  scope: string,
  token: string,
): BalanceEntry | undefined {
  return records.entries.find((e) => e.scope === scope && e.token === token)
}

/** Main's records, once the account and the token rows are read. */
export function selectWallet(
  network: string | null,
  account: Sourced<AccountRow>,
  tokens: Sourced<TokenRows>,
  active: string | null,
  decimalsPending: boolean,
): WalletTokens | null {
  if (!network || !account.value || !tokens.loaded) return null
  return {
    scope: balanceScope(network, account.value.completeAddress),
    tokens: tokens.value
      .filter((t) => (!!active && sameAddress(t.address, active)) || isWalletTokenSymbol(t.symbol))
      .map(({ address, decimals }) => ({ address, decimals })),
    active,
    decimalsPending,
  }
}

/** `sessionStart` tells a read from this session from one hydrated from cache. */
export function selectBalanceView(
  records: BalanceRecords,
  wallet: WalletTokens | null,
  sync: BalanceSync,
  sessionStart: number,
): BalanceView {
  const scoped =
    wallet && records.hydrated ? records.entries.filter((e) => e.scope === wallet.scope) : []
  const held = (wallet?.tokens ?? []).flatMap((t) => {
    const atomic = scoped.find((e) => e.token === t.address)?.atomic ?? 0n
    return atomic > 0n ? [{ address: t.address, atomic, decimals: t.decimals }] : []
  })
  const active = wallet?.active
  const pick = active
    ? held.find((h) => sameAddress(h.address, active))
    : held.length === 1
    ? held[0]
    : undefined
  const main = pick ? { atomic: pick.atomic, decimals: pick.decimals } : null
  const live =
    !!wallet?.tokens.length &&
    !wallet.decimalsPending &&
    scoped.some((e) => (e.updatedAt ?? 0) >= sessionStart)
  return {
    main,
    live,
    known: live || (!sync.syncing && main !== null),
    syncing: sync.syncing,
    progress: sync.progress,
    readAt: active ? scoped.find((e) => sameAddress(e.token, active))?.readAt : undefined,
  }
}

/** An amount the live balance cannot cover. Unknown until a read from this session lands. */
export function exceedsBalance(view: BalanceView, amount: bigint | undefined): boolean {
  return view.live && amount !== undefined && amount > (view.main?.atomic ?? 0n)
}

/**
 * Home's Main figure. Funds on their way count where they land. A held upgrade lock shows what the
 * upgrade will land instead.
 */
export function selectHomeMain(
  view: BalanceView,
  home: {
    arriving: bigint
    lock: { checked: boolean; held: boolean; main?: bigint }
    oldVersionsPending: boolean
    upgradesLoaded: boolean
  },
): { shown: bigint | undefined; known: boolean } {
  const { lock } = home
  const settled = view.known && !home.oldVersionsPending && home.upgradesLoaded
  return {
    shown: lock.held ? lock.main : (view.main?.atomic ?? 0n) + home.arriving,
    known: lock.checked && (lock.held || settled),
  }
}

const sameWallet = (a: WalletTokens | null, b: WalletTokens | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.scope === b.scope &&
    a.active === b.active &&
    a.decimalsPending === b.decimalsPending &&
    a.tokens.length === b.tokens.length &&
    a.tokens.every(
      (t, i) => t.address === b.tokens[i].address && t.decimals === b.tokens[i].decimals,
    ))

const sameView = (a: BalanceView, b: BalanceView) =>
  a.main?.atomic === b.main?.atomic &&
  a.main?.decimals === b.main?.decimals &&
  a.live === b.live &&
  a.known === b.known &&
  a.syncing === b.syncing &&
  a.progress === b.progress &&
  a.readAt === b.readAt

/** The balances store over persisted records, joined with the wallet's rows and the boot sync. */
export function createBalances(
  source: BalanceSource,
  wallet: WalletSources,
  sync: ReadonlyStore<BalanceSync>,
  now: () => number = Date.now,
): Balances {
  const sessionStart = now()
  const store = memoryStore<BalanceRecords>({
    hydrated: false,
    entries: source.list().flatMap(toEntry),
  })
  const main = derived(
    [wallet.account, wallet.tokens, wallet.active, wallet.decimalsPending],
    (account, tokens, active, pending) =>
      selectWallet(wallet.network, account, tokens, active, pending),
    sameWallet,
  )
  const mirror = (list: readonly BalanceRecord[], hydrated = store.get().hydrated) =>
    store.update((s) => ({ ...s, hydrated, entries: list.flatMap(toEntry) }))
  let watchers = 0
  let stop = () => {}
  // Mirrors the source while anything watches: subscribe, then read, so no write is missed.
  const records: ReadonlyStore<BalanceRecords> = {
    get: store.get,
    subscribe(listener) {
      const off = store.subscribe(listener)
      if (watchers++ === 0) {
        let stopped = false
        const unwatch = source.onListChanged((list) => mirror(list))
        mirror(source.list())
        // The source logs a failed read. It still hydrates: an empty list beats a stuck placeholder.
        const hydrate = () => {
          if (!stopped) mirror(source.list(), true)
        }
        void source.load().then(hydrate, hydrate)
        stop = () => {
          stopped = true
          unwatch()
        }
      }
      let done = false
      return () => {
        if (done) return
        done = true
        off()
        if (--watchers === 0) stop()
      }
    },
  }
  return {
    records,
    view: derived(
      [records, main, sync],
      (r, w, s) => selectBalanceView(r, w, s, sessionStart),
      sameView,
    ),
  }
}
