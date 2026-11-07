import { depositOwed, registrationStage } from "../core/services/registration"
import type { Database, Reads, Write } from "./database"
import { WalletError } from "./errors"
import {
  encodeRecord,
  loadRecords,
  persistentStore,
  type PersistentStore,
  type RecordSet,
} from "./persistentStore"
import {
  isTerminalRegistrationPhase,
  isTicketSignup,
  PENDING_REGISTRATION_STORAGE_KEY,
  REGISTRATION_ROUTES,
  routeConfirmsTag,
  type PendingRegistrationPhase,
  type PendingRegistrationRecord,
  type RegistrationRefunds,
  type RegistrationRoute,
  type RegistrationTerms,
} from "./registrationRecord"
import {
  LINK_BINDING,
  registrationTransition,
  type RegistrationChange,
  type RegistrationEvent,
} from "./registrationTransition"
import type { SipaDeposits } from "./sipaDeposits"
import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import { ACCOUNT_STORAGE_KEY } from "../core/storages/constants"
import { memoryStore, type ReadonlyStore } from "./store"

export * from "./registrationTransition"

const PREFIX = "acct/registrations"

/** A record's id: its lowercase address. */
export const registrationId = (sipaAddress: string) => sipaAddress.toLowerCase()

/** Device-wide keys older builds kept beside the records, on the page's database. */
const SIDE = {
  replaced: "webwallet.registration.replaced",
  confirmed: "webwallet.registration.confirmed",
  refunds: "webwallet.registration.refunds",
  recovery: "webwallet.registration.recovery",
  noticeAck: "webwallet.registration.noticeAck",
  route: "webwallet.registration.route",
} as const
const termsKey = (account: string, tag: string) =>
  `webwallet.registration.terms:${account.toLowerCase()}:${tag.toLowerCase()}`

const PHASES = new Set<PendingRegistrationPhase>([
  "awaiting_deposit",
  "funded",
  "confirmed",
  "failed_taken",
  "failed_terminal",
  "replaced",
])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const unreadable = (detail: string) => new WalletError("unknown", `registrations: ${detail}`)

/** A saved record as this store keeps it. Anything else fails the open. */
function carried(value: unknown): PendingRegistrationRecord {
  if (!isObject(value)) throw unreadable("a saved record is not one")
  const strings = ["account", "tag", "nameHash", "l2Address", "sipaAddress", "depositToken"]
  const numbers = ["l1ChainId", "retries", "startTime"]
  if (
    !strings.every((k) => typeof value[k] === "string") ||
    !numbers.every((k) => typeof value[k] === "number") ||
    typeof value.fee !== "string" ||
    typeof value.beneficiary !== "string" ||
    typeof value.broadcast !== "boolean" ||
    !PHASES.has(value.phase as PendingRegistrationPhase)
  )
    throw unreadable(`the saved record at ${String(value.sipaAddress)} is not one`)
  const { nextAttemptAt, ...record } = value
  void nextAttemptAt
  // A record an older build saw funded keeps that as its first funding.
  if (typeof record.fundedAt === "number" && record.firstFundedAt === undefined)
    record.firstFundedAt = record.fundedAt
  return record as unknown as PendingRegistrationRecord
}

/** The L2 address of the namespace's saved account. */
export async function ownAddress(raw: string | undefined): Promise<string | undefined> {
  const saved = sideValue(raw)
  const complete = isObject(saved) ? saved.completeAddress : undefined
  if (typeof complete !== "string") return undefined
  return (await CompleteAddress.fromString(complete)).address.toString().toLowerCase()
}

function parsed(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw unreadable(`${what} do not parse`)
  }
}

/** A side key's value as older builds' readers took it: one that does not parse reads as absent. */
function sideValue(raw: string | undefined): unknown {
  try {
    return raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

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

/** Whether a write that confirms the tag owes the address's broadcast. */
function owesBroadcast(record: PendingRegistrationRecord): boolean {
  return (
    !isTerminalRegistrationPhase(record.phase) &&
    !record.broadcast &&
    !record.replaced?.broadcastSpent &&
    !isTicketSignup(record.terms)
  )
}

/** Whether an older build confirmed the tag and never owed the address's broadcast. */
function confirmedUnpublished(
  record: PendingRegistrationRecord,
  deposit: Awaited<ReturnType<SipaDeposits["get"]>>,
): boolean {
  if (!owesBroadcast(record) || deposit?.broadcast) return false
  return (
    record.tagConfirmed === true ||
    routeConfirmsTag(record.route) ||
    !depositOwed(registrationStage(record, { deposit }))
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

  /**
   * Version 1 carries every legacy record, then folds the side keys that name one of them onto it.
   * A record an older build confirmed and never published gets its broadcast owed. Corrupt records
   * fail the open, which keeps the saved bytes.
   */
  const migrate = async (from: number | undefined, w: Write): Promise<void> => {
    if (from !== undefined)
      throw new WalletError("invariant", `registrations: unknown version ${from}`)
    const records = new Map<string, PendingRegistrationRecord>()
    const blob = await w.get(PENDING_REGISTRATION_STORAGE_KEY)
    if (blob !== undefined) {
      const saved = parsed(blob, "the saved records")
      if (!isObject(saved)) throw unreadable("the saved records are not a record map")
      for (const value of Object.values(saved)) {
        const record = carried(value)
        records.set(registrationId(record.sipaAddress), record)
      }
    }
    // The archive is device-wide: a record is this namespace's when a live one names its account,
    // or when it registers the namespace's own address.
    const accounts = new Set([...records.values()].map((r) => r.account.toLowerCase()))
    const address = await ownAddress(await w.get(ACCOUNT_STORAGE_KEY))
    const ours = (r: PendingRegistrationRecord) =>
      accounts.has(r.account.toLowerCase()) || r.l2Address.toLowerCase() === address

    const keys = Object.values(SIDE)
    const side = Object.fromEntries(
      (await legacy.getMany(keys)).map((raw, i) => [keys[i], raw]),
    ) as Record<(typeof keys)[number], string | undefined>

    const archived = new Set<string>()
    const replaced = side[SIDE.replaced]
    if (replaced !== undefined) {
      const list = parsed(replaced, "the replaced records")
      if (!Array.isArray(list)) throw unreadable("the replaced records are not a list")
      for (const value of list) {
        const record = carried(value)
        const id = registrationId(record.sipaAddress)
        if (ours(record) && !records.has(id)) {
          records.set(id, record)
          archived.add(id)
        }
      }
    }
    if (records.size === 0) return

    const fold = (id: string, patch: Partial<PendingRegistrationRecord>) => {
      const record = records.get(id)
      if (record) records.set(id, { ...record, ...patch })
    }
    const notice = (id: string, patch: NonNullable<PendingRegistrationRecord["notice"]>) =>
      fold(id, { notice: { ...records.get(id)?.notice, ...patch } })
    const newestOf = (match: (r: PendingRegistrationRecord) => boolean) =>
      newestFirst(records.values()).find(match)

    const pairs = new Map<string, PendingRegistrationRecord>()
    for (const record of newestFirst(records.values())) {
      const key = termsKey(record.account, record.tag)
      if (!pairs.has(key)) pairs.set(key, record)
    }
    const terms = await legacy.getMany([...pairs.keys()])
    for (const [i, record] of [...pairs.values()].entries()) {
      const value = sideValue(terms[i])
      if (!isObject(value)) continue
      const { account, tag, ...kept } = value
      void account
      void tag
      fold(registrationId(record.sipaAddress), { terms: kept as unknown as RegistrationTerms })
    }

    const confirmed = sideValue(side[SIDE.confirmed])
    if (Array.isArray(confirmed))
      for (const address of confirmed)
        if (typeof address === "string") fold(registrationId(address), { tagConfirmed: true })

    const refunds = sideValue(side[SIDE.refunds])
    if (isObject(refunds))
      for (const [address, evidence] of Object.entries(refunds)) {
        if (!isObject(evidence) || !Array.isArray(evidence.txHashes)) continue
        const { txHashes, amounts } = evidence as unknown as RegistrationRefunds
        fold(registrationId(address), { refunds: { txHashes, ...(amounts ? { amounts } : {}) } })
      }

    const recoveryTag = side[SIDE.recovery]
    const recovered =
      recoveryTag && newestOf((r) => r.tag === recoveryTag && r.phase === "confirmed")
    if (recovered) notice(registrationId(recovered.sipaAddress), { recovery: true })

    const ack = side[SIDE.noticeAck]
    const acknowledged =
      ack &&
      newestOf((r) => `${r.account.toLowerCase()}:${r.endTime ?? r.startTime}:${r.phase}` === ack)
    if (acknowledged) notice(registrationId(acknowledged.sipaAddress), { acknowledged: true })

    const route = sideValue(side[SIDE.route])
    if (isObject(route) && REGISTRATION_ROUTES.includes(route.route as RegistrationRoute)) {
      const tagged = newestOf((r) => r.tag === route.tag)
      if (tagged)
        fold(registrationId(tagged.sipaAddress), { route: route.route as RegistrationRoute })
    }

    for (const id of archived) fold(id, { phase: "replaced" })

    const at = Date.now()
    for (const [id, record] of records) {
      w.put(`${PREFIX}/${id}`, encodeRecord(record))
      if (!confirmedUnpublished(record, await deps.deposits.get(id, w))) continue
      await deps.deposits.apply(
        id,
        {
          type: "broadcastOwed",
          address: id,
          owed: { kind: "registration", source: { type: "registration", account: record.account } },
          at,
        },
        w,
      )
    }
  }

  // The migration owes broadcasts on the deposit records, so it opens once their store has.
  const opening: Promise<PersistentStore<PendingRegistrationRecord>> = deps.deposits.ready.then(
    () =>
      persistentStore<PendingRegistrationRecord>(db, {
        prefix: PREFIX,
        version: 1,
        id: (record) => registrationId(record.sipaAddress),
        migrate,
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
    const now = Date.now()
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
        at: Date.now(),
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
