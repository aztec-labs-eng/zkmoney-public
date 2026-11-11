/**
 * Storage migration: older builds' registration records and the device-wide side keys beside them.
 * Remove when no supported build older than the one that writes `acct/registrations` v1 remains.
 */
import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import { depositOwed, registrationStage } from "../core/services/registration"
import { ACCOUNT_STORAGE_KEY } from "../core/storages/constants"
import type { Reads, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord } from "../engine/persistentStore"
import {
  REGISTRATION_ROUTES,
  routeConfirmsTag,
  type PendingRegistrationPhase,
  type PendingRegistrationRecord,
  type RegistrationRefunds,
  type RegistrationRoute,
  type RegistrationTerms,
  registrationId,
} from "../engine/registrationRecord"
import type { SipaDeposits } from "../engine/sipaDeposits"

/** The blob older builds kept the records in, keyed by L1 account. */
export const PENDING_REGISTRATION_STORAGE_KEY = "@obsidion/pending-registration/records"

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

// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
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

/** Whether an older build confirmed the tag and never owed the address's broadcast. */
function confirmedUnpublished(
  record: PendingRegistrationRecord,
  deposit: Awaited<ReturnType<SipaDeposits["get"]>>,
  owesBroadcast: (record: PendingRegistrationRecord) => boolean,
): boolean {
  if (!owesBroadcast(record) || deposit?.broadcast) return false
  return (
    record.tagConfirmed === true ||
    routeConfirmsTag(record.route) ||
    !depositOwed(registrationStage(record, { deposit }))
  )
}

/**
 * Version 1 carries every legacy record, then folds the side keys that name one of them onto it.
 * A record an older build confirmed and never published gets its broadcast owed. Corrupt records
 * fail the open, which keeps the saved bytes.
 */
export async function migrateRegistrations(
  from: number | undefined,
  w: Write,
  deps: {
    prefix: string
    legacy: Pick<Reads, "getMany">
    deposits: Pick<SipaDeposits, "get" | "apply">
    owesBroadcast: (record: PendingRegistrationRecord) => boolean
  },
): Promise<void> {
  const { prefix, legacy } = deps
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
  const recovered = recoveryTag && newestOf((r) => r.tag === recoveryTag && r.phase === "confirmed")
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
    w.put(`${prefix}/${id}`, encodeRecord(record))
    if (!confirmedUnpublished(record, await deps.deposits.get(id, w), deps.owesBroadcast)) continue
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
