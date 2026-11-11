import { TransactionNotFoundError, TransactionReceiptNotFoundError, type PublicClient } from "viem"
import type { Database, Reads, Write } from "./database"
import { WalletError } from "./errors"
import {
  loadRecords,
  persistentStore,
  type PersistentStore,
  type RecordSet,
} from "./persistentStore"
import {
  isTerminalRegistrationPhase,
  isTicketSignup,
  registrationId,
  routeConfirmsTag,
  type PendingRegistrationRecord,
  type SubmittedTx,
} from "./registrationRecord"
import {
  LINK_BINDING,
  registrationTransition,
  type RegistrationChange,
  type RegistrationEvent,
} from "./registrationTransition"
import type { SipaDeposits } from "./sipaDeposits"
import { memoryStore, type ReadonlyStore } from "./store"
import type { UnresolvedSendState } from "./unresolvedSends"
import { migrateRegistrations } from "../storageMigrations/registrations"

export * from "./registrationTransition"

const PREFIX = "acct/registrations"

/** A record's id: its lowercase address. */
const newestFirst = (records: Iterable<PendingRegistrationRecord>) =>
  [...records].sort((a, b) => b.startTime - a.startTime)

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const ofWallet = (record: PendingRegistrationRecord, l2Address?: string) =>
  l2Address === undefined || sameAddress(record.l2Address, l2Address)
const isFailed = (record: PendingRegistrationRecord) =>
  record.phase === "failed_taken" || record.phase === "failed_terminal"

/** The L1 account's newest record: the one its sessions and ticks act on. */
export function latestRegistration(
  records: readonly PendingRegistrationRecord[],
  account: string,
): PendingRegistrationRecord | null {
  return newestFirst(records).find((r) => sameAddress(r.account, account)) ?? null
}

/** The newest open record, of one wallet when `l2Address` names it. */
export function currentRegistration(
  records: readonly PendingRegistrationRecord[],
  l2Address?: string,
): PendingRegistrationRecord | null {
  return (
    newestFirst(records).find(
      (r) => !isTerminalRegistrationPhase(r.phase) && ofWallet(r, l2Address),
    ) ?? null
  )
}

/**
 * Whether a record, closed ones too, names the link `paylinkId` and the link's claim burned to the
 * record's address. A record whose link was never claimed leaves the link claimable.
 */
export function registrationSpentLink(
  records: readonly PendingRegistrationRecord[],
  paylinkId: string,
  burns: readonly { recipient: string; phase: string }[],
): boolean {
  return records.some((r) => {
    if (r.terms?.paylinkId !== paylinkId) return false
    const sipa = r.sipaAddress.toLowerCase()
    return burns.some((b) => b.recipient.toLowerCase() === sipa && b.phase !== "failed")
  })
}

/** The newest failed record, of one wallet when `l2Address` names it. */
export function latestFailedRegistration(
  records: readonly PendingRegistrationRecord[],
  l2Address?: string,
): PendingRegistrationRecord | null {
  return newestFirst(records).find((r) => isFailed(r) && ofWallet(r, l2Address)) ?? null
}

/** The record at `sipaAddress`, if the loaded set holds one. */
export function registrationAt(
  records: readonly PendingRegistrationRecord[],
  sipaAddress: string,
): PendingRegistrationRecord | null {
  return records.find((r) => sameAddress(r.sipaAddress, sipaAddress)) ?? null
}

export type RegistrationPayRun = "checking" | "sending" | "confirming" | "check" | "sent"

/** This wallet's payment to a registration address: past the screen's run, the saved one. */
export function registrationPayment(
  address: string,
  record: Pick<PendingRegistrationRecord, "submittedFunding" | "fundedAt" | "sweptAt"> | null,
  hold: UnresolvedSendState,
  run?: RegistrationPayRun,
): RegistrationPayRun | "holding" | "idle" {
  if (run) return run
  if (record?.fundedAt !== undefined || record?.sweptAt !== undefined) return "idle"
  if (record?.submittedFunding) return "check"
  if (hold.status === "held" && sameAddress(hold.send.address, address)) return "holding"
  return "idle"
}

/**
 * How long a hash saved without its sender may stay unknown to the node before it reads as gone.
 * Private relays drop what they cannot land within minutes (Flashbots Protect after 25 blocks). The
 * accepted cost: a transfer the read node never saw that still lands after the hour pays twice.
 */
export const UNKNOWN_HASH_MS = 60 * 60 * 1000

/**
 * Whether a saved transaction is still to land. With no receipt for its hash, a sender nonce
 * confirmed past its own means it was replaced or dropped: it never will. A save without the
 * sender and nonce reads them from the node and hands them to `learned`. A hash the node does not
 * know waits until `UNKNOWN_HASH_MS` after it was sent.
 */
export async function submissionGone(
  client: Pick<PublicClient, "getTransaction" | "getTransactionCount" | "getTransactionReceipt">,
  saved: SubmittedTx,
  learned: (tx: SubmittedTx) => Promise<unknown>,
  now: number,
): Promise<boolean> {
  const { txHash } = saved
  let { from, nonce } = saved
  if (from === undefined || nonce === undefined) {
    try {
      ;({ from, nonce } = await client.getTransaction({ hash: txHash }))
    } catch (e) {
      if (e instanceof TransactionNotFoundError) return now - saved.at > UNKNOWN_HASH_MS
      throw e
    }
    await learned({ ...saved, from, nonce })
  }
  // Read first: a transaction mined after this read still shows its receipt below.
  const confirmed = await client.getTransactionCount({ address: from, blockTag: "latest" })
  try {
    await client.getTransactionReceipt({ hash: txHash })
    return false
  } catch (e) {
    if (!(e instanceof TransactionReceiptNotFoundError)) throw e
  }
  return confirmed > nonce
}

/** Whether a write that confirms the tag owes the address's broadcast. */
function owesBroadcast(record: PendingRegistrationRecord): boolean {
  return (
    !isTerminalRegistrationPhase(record.phase) &&
    !record.broadcast &&
    !record.replaced?.broadcastSpent &&
    !isTicketSignup(record.terms)
  )
}

export interface RegistrationsDeps {
  /** The account's database. */
  db: Database
  /** The page's database, where older builds kept the device-wide side keys. */
  legacy: Pick<Reads, "getMany">
  /** The account's SIPA deposits: an owed broadcast is filed on the address's record. */
  deposits: Pick<SipaDeposits, "ready" | "get" | "apply">
  /** Whether the namespace is an account's: a page with no account files no registration. */
  account: boolean
  /** Hears each change this store committed itself, after its commit: the funnel's source. */
  committed?(changes: readonly RegistrationChange[]): void
  now: () => number
}

/**
 * The account's registrations, one record per registration SIPA, keyed by lowercase address. A
 * record changes only through `registrationTransition`, and none is ever removed. Every record
 * loads. A failed open reports `failed` and every write rejects.
 */
export interface RegistrationStore {
  readonly view: ReadonlyStore<RecordSet<PendingRegistrationRecord>>
  /** Settles once `view` has loaded, with every write committed before it settles. */
  readonly ready: Promise<void>
  get(sipaAddress: string, w?: Write): Promise<PendingRegistrationRecord | undefined>
  /** The change when `event` changed the record. */
  apply(
    sipaAddress: string,
    event: RegistrationEvent,
    w?: Write,
  ): Promise<RegistrationChange | undefined>
  /** Applies each event to its record in order, in one transaction. */
  applyAll(
    events: readonly (readonly [string, RegistrationEvent])[],
    w?: Write,
  ): Promise<RegistrationChange[]>
  /**
   * A session's record, in one write: the account's other open records close as replaced, and a
   * route that confirms the tag owes the address's broadcast.
   */
  start(event: Extract<RegistrationEvent, { type: "started" }>): Promise<PendingRegistrationRecord>
  /** The user settled on the tag, and the address's broadcast is owed, in one write. */
  confirmTag(sipaAddress: string): Promise<RegistrationChange | undefined>
  /**
   * The link that was to pay the deposit closed unclaimed. Its binding goes, and a settled tag owes
   * the address's broadcast, in one write: the user is asked for the deposit again.
   */
  releaseLink(sipaAddress: string): Promise<RegistrationChange | undefined>
  /**
   * A broadcast of `sipaAddress` landed. When the account opened another record since, it spent
   * that record's rail too, in the same write.
   */
  broadcastSent(sipaAddress: string): Promise<void>
}

export function createRegistrations(deps: RegistrationsDeps): RegistrationStore {
  const { db, legacy } = deps

  // The migration owes broadcasts on the deposit records, so it opens once their store has.
  const opening: Promise<PersistentStore<PendingRegistrationRecord>> = deps.deposits.ready.then(
    () =>
      persistentStore<PendingRegistrationRecord>(db, {
        prefix: PREFIX,
        version: 1,
        id: (record) => registrationId(record.sipaAddress),
        migrate: (from, w) =>
          migrateRegistrations(from, w, {
            prefix: PREFIX,
            legacy,
            deposits: deps.deposits,
            owesBroadcast,
          }),
        load: "all",
      }),
  )
  const view = memoryStore<RecordSet<PendingRegistrationRecord>>({
    records: [],
    loaded: false,
    failed: false,
  })
  const ready = opening.then(async (store) => {
    const follow = () => view.set(store.view.get())
    store.view.subscribe(follow)
    follow()
    await store.ready
    await loadRecords(store.view)
  })
  void ready.then(undefined, () => view.set({ ...view.get(), failed: true }))

  const writing = async <T>(
    w: Write | undefined,
    fn: (store: PersistentStore<PendingRegistrationRecord>, w: Write) => Promise<T>,
  ): Promise<T> => {
    if (!deps.account)
      throw new WalletError("wallet.notReady", "registrations: no account to file one under")
    const store = await opening
    if (w) return fn(store, w)
    await store.ready
    return db.write((w) => fn(store, w))
  }
  /** `events` in order, in `w`; the caller hears the changes. */
  const applied = async (
    store: PersistentStore<PendingRegistrationRecord>,
    events: readonly (readonly [string, RegistrationEvent])[],
    w: Write,
  ) => {
    const changes: RegistrationChange[] = []
    const now = deps.now()
    for (const [address, event] of events) {
      // The store's own queue for `w`: concurrent changes to one record each read the last.
      await store.apply(
        registrationId(address),
        (current) => {
          const change = registrationTransition(current, event, now)
          if (change) changes.push(change)
          return change?.record
        },
        w,
      )
    }
    return changes
  }
  /** A write this store commits itself, heard once it lands. */
  const own = async (
    fn: (
      store: PersistentStore<PendingRegistrationRecord>,
      w: Write,
    ) => Promise<RegistrationChange[]>,
  ) => {
    const changes = await writing(undefined, fn)
    if (changes.length > 0) deps.committed?.(changes)
    return changes
  }
  const owe = (record: PendingRegistrationRecord, w: Write) =>
    deps.deposits.apply(
      record.sipaAddress,
      {
        type: "broadcastOwed",
        address: registrationId(record.sipaAddress),
        owed: { kind: "registration", source: { type: "registration", account: record.account } },
        at: deps.now(),
      },
      w,
    )
  const others = (
    store: PersistentStore<PendingRegistrationRecord>,
    account: string,
    except: string,
  ) =>
    store.view
      .get()
      .records.filter(
        (r) =>
          sameAddress(r.account, account) &&
          !sameAddress(r.sipaAddress, except) &&
          !isTerminalRegistrationPhase(r.phase),
      )

  return {
    view: view.readonly,
    ready,
    async get(sipaAddress, w) {
      return (await opening).get(registrationId(sipaAddress), w)
    },
    applyAll: (events, w) =>
      w
        ? writing(w, (store, w) => applied(store, events, w))
        : own((store, w) => applied(store, events, w)),
    async apply(sipaAddress, event, w) {
      const [change] = w
        ? await writing(w, (store, w) => applied(store, [[sipaAddress, event]], w))
        : await own((store, w) => applied(store, [[sipaAddress, event]], w))
      return change
    },
    async start(event) {
      const { account, sipaAddress } = event.record
      let started: PendingRegistrationRecord | undefined
      await own(async (store, w) => {
        const replaced = others(store, account, sipaAddress).map(
          (r) => [r.sipaAddress, { type: "replaced" }] as const,
        )
        const changes = await applied(store, [...replaced, [sipaAddress, event]], w)
        started = await store.get(registrationId(sipaAddress), w)
        if (started && routeConfirmsTag(started.route) && owesBroadcast(started))
          await owe(started, w)
        return changes
      })
      if (!started) throw new WalletError("invariant", "registrations: a start wrote no record")
      return started
    },
    async confirmTag(sipaAddress) {
      const [change] = await own(async (store, w) => {
        const changes = await applied(store, [[sipaAddress, { type: "tagConfirmed" }]], w)
        const record = await store.get(registrationId(sipaAddress), w)
        if (record && owesBroadcast(record)) await owe(record, w)
        return changes
      })
      return change
    },
    async releaseLink(sipaAddress) {
      const unbound = Object.fromEntries(LINK_BINDING.map((key) => [key, undefined]))
      const [change] = await own(async (store, w) => {
        const changes = await applied(
          store,
          [[sipaAddress, { type: "termsUpdated", terms: unbound }]],
          w,
        )
        const record = await store.get(registrationId(sipaAddress), w)
        const settled = record?.tagConfirmed === true || routeConfirmsTag(record?.route)
        if (record && settled && owesBroadcast(record)) await owe(record, w)
        return changes
      })
      return change
    },
    async broadcastSent(sipaAddress) {
      await own(async (store, w) => {
        const record = await store.get(registrationId(sipaAddress), w)
        if (!record) return []
        const spent = others(store, record.account, sipaAddress).map(
          (r) => [r.sipaAddress, { type: "predecessorBroadcast", sipaAddress }] as const,
        )
        return applied(store, [[sipaAddress, { type: "broadcastSent" }], ...spent], w)
      })
    },
  }
}
