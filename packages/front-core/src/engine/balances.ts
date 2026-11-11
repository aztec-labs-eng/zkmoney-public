import { migrateBalances } from "../storageMigrations/balances"
import { balanceTransition } from "./balanceTransition"
import type { Database } from "./database"
import type { BalanceSync } from "./milestones"
import { isWalletTokenSymbol } from "../utils/tokenIdentity"
import type { Sourced } from "./legacyStore"
import { persistentStore, type RecordSet } from "./persistentStore"
import { derived, type ReadonlyStore } from "./store"

/**
 * One stored balance. `scope` is `balanceScope(network, accountCompleteAddress)`, so a stored value
 * never surfaces for another network or account. `anchor` is the PXE block it was read at;
 * `readAt` is wall-clock ms the read resolved, `updatedAt` of the write. `symbol` names Main's
 * read, so a cached figure shows before the token builds.
 */
export interface BalanceEntry {
  scope: string
  token: string
  atomic: bigint
  anchor?: number
  readAt?: number
  updatedAt?: number
  symbol?: string
}

export const balanceScope = (network: string | undefined, accountCompleteAddress: string) =>
  `${network}:${accountCompleteAddress}`

/** The account's last balance reads. The sync coordinator writes the live scope's. */
export interface BalanceStore {
  ready: Promise<void>
  view: ReadonlyStore<RecordSet<BalanceEntry>>
  /** False when a read at a newer anchor is stored. Rejects when the write fails. */
  write(
    scope: string,
    token: string,
    atomic: bigint,
    anchor?: number,
    readAt?: number,
    symbol?: string,
  ): Promise<boolean>
}

const BALANCES = "acct/balances"
const balanceId = (entry: BalanceEntry) => `${entry.scope}:${entry.token}`

export function createBalanceStore({ db, now }: { db: Database; now: () => number }): BalanceStore {
  const spec = { prefix: BALANCES, id: balanceId }
  const store = persistentStore<BalanceEntry>(db, {
    ...spec,
    version: 1,
    migrate: (from, w) => migrateBalances(from, w, spec),
    load: "all",
  })
  return {
    ready: store.ready,
    view: store.view,
    async write(scope, token, atomic, anchor, readAt, symbol) {
      const at = now()
      const next: BalanceEntry = {
        scope,
        token,
        atomic,
        anchor,
        readAt: readAt ?? at,
        updatedAt: at,
        ...(symbol ? { symbol } : {}),
      }
      const wrote = await store.apply(balanceId(next), (current) =>
        balanceTransition(current, next),
      )
      return wrote !== undefined
    },
  }
}

/**
 * Which records are Main's: the live scope and the token's address once the token is built. Before
 * that, the scope's reads named with the wallet token's symbol are the candidates.
 */
export interface WalletTokens {
  scope: string
  tokens: readonly string[]
  active: string | null
}

export interface BalanceView {
  /**
   * Main's balance, or null when none above zero can be told apart. Before the token address
   * resolves only a lone candidate counts: guessing could pin a stale balance on screen.
   */
  main: { atomic: bigint } | null
  /** A read from this session landed. Spend checks trust only this, never the cache. */
  readThisSession: boolean
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
  /**
   * Main's token address: the built token's. Before it builds, the row Main shows, else the lone
   * stored row's.
   */
  token: string | null
  /** The PXE block Main's balance was read at; funds moved in a later block are not in it. */
  anchor: number | undefined
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

type AccountRow = { completeAddress: string } | undefined

/** What names Main's records. */
export interface WalletSources {
  /** The session's network type; null before it is known. */
  network: string | null
  account: ReadonlyStore<Sourced<AccountRow>>
  /** The token's address, or null before the token is built. */
  activeToken: ReadonlyStore<string | null>
}

export interface Balances {
  records: ReadonlyStore<RecordSet<BalanceEntry>>
  view: ReadonlyStore<BalanceView>
}

export function selectEntry(
  records: RecordSet<BalanceEntry>,
  scope: string,
  token: string,
): BalanceEntry | undefined {
  return records.records.find((e) => e.scope === scope && e.token === token)
}

/** Main's records, once the account and the token, or its named reads, are read. */
export function selectWallet(
  network: string | null,
  account: Sourced<AccountRow>,
  balances: RecordSet<BalanceEntry>,
  active: string | null,
): WalletTokens | null {
  if (!network || !account.value || (!active && !balances.loaded)) return null
  const scope = balanceScope(network, account.value.completeAddress)
  return {
    scope,
    tokens: active
      ? [active]
      : balances.records
          .filter((e) => e.scope === scope && isWalletTokenSymbol(e.symbol))
          .map((e) => e.token),
    active,
  }
}

/** `sessionStart` tells a read from this session from one hydrated from cache. */
export function selectBalanceView(
  records: RecordSet<BalanceEntry>,
  wallet: WalletTokens | null,
  sync: BalanceSync,
  sessionStart: number,
): BalanceView {
  const scoped = wallet ? records.records.filter((e) => e.scope === wallet.scope) : []
  const held = (wallet?.tokens ?? []).flatMap((address) => {
    const atomic = scoped.find((e) => sameAddress(e.token, address))?.atomic ?? 0n
    return atomic > 0n ? [{ address, atomic }] : []
  })
  const active = wallet?.active
  const pick = active
    ? held.find((h) => sameAddress(h.address, active))
    : held.length === 1
    ? held[0]
    : undefined
  const main = pick ? { atomic: pick.atomic } : null
  const live = !!wallet?.tokens.length && scoped.some((e) => (e.updatedAt ?? 0) >= sessionStart)
  const token = active ?? pick?.address ?? (wallet?.tokens.length === 1 ? wallet.tokens[0]! : null)
  const read = token ? scoped.find((e) => sameAddress(e.token, token)) : undefined
  return {
    main,
    readThisSession: live,
    known: live || (!sync.syncing && main !== null),
    syncing: sync.syncing,
    progress: sync.progress,
    readAt: active ? read?.readAt : undefined,
    token,
    anchor: read?.anchor,
  }
}

/** An amount the live balance cannot cover. Unknown until a read from this session lands. */
export function exceedsBalance(view: BalanceView, amount: bigint | undefined): boolean {
  return view.readThisSession && amount !== undefined && amount > (view.main?.atomic ?? 0n)
}

/**
 * Home's Main figure. Funds on their way count where they land. A held upgrade lock shows what the
 * upgrade will land instead. `updating` marks a cached figure no read from this session confirmed:
 * it can be stale.
 */
export function selectHomeMain(
  view: BalanceView,
  home: {
    arriving: bigint
    lock: { checked: boolean; held: boolean; main?: bigint }
    upgradesLoaded: boolean
  },
): { shown: bigint | undefined; known: boolean; updating: boolean } {
  const { lock } = home
  const known = lock.checked && (lock.held || (view.known && home.upgradesLoaded))
  return {
    shown: lock.held ? lock.main : (view.main?.atomic ?? 0n) + home.arriving,
    known,
    updating: known && !lock.held && !view.readThisSession,
  }
}

const sameWallet = (a: WalletTokens | null, b: WalletTokens | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.scope === b.scope &&
    a.active === b.active &&
    a.tokens.length === b.tokens.length &&
    a.tokens.every((t, i) => t === b.tokens[i]))

const sameView = (a: BalanceView, b: BalanceView) =>
  a.main?.atomic === b.main?.atomic &&
  a.readThisSession === b.readThisSession &&
  a.known === b.known &&
  a.syncing === b.syncing &&
  a.progress === b.progress &&
  a.readAt === b.readAt &&
  a.token === b.token &&
  a.anchor === b.anchor

/** Main's balance over the stored reads, joined with the account, the token and the boot sync. */
export function createBalances(
  records: ReadonlyStore<RecordSet<BalanceEntry>>,
  wallet: WalletSources,
  sync: ReadonlyStore<BalanceSync>,
  now: () => number,
): Balances {
  const sessionStart = now()
  const main = derived(
    [wallet.account, records, wallet.activeToken],
    (account, balances, active) => selectWallet(wallet.network, account, balances, active),
    sameWallet,
  )
  return {
    records,
    view: derived(
      [records, main, sync],
      (r, w, s) => selectBalanceView(r, w, s, sessionStart),
      sameView,
    ),
  }
}
