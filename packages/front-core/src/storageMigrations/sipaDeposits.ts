/**
 * Storage migration: older builds' SIPA deposits, broadcasts, slots and pool entries. Remove when
 * no supported build older than the one that writes `acct/sipaDeposits` v3 remains and the rollup
 * migration (ZKM-1625) reads no deposit blob.
 */
import type { Database, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { decodeRecord, encodeRecord } from "../engine/persistentStore"
import { broadcastStub, sipaDepositId } from "../engine/sipaDepositTransition"
import type {
  BroadcastSource,
  SipaBroadcast,
  SipaBroadcastWait,
  SipaDeposit,
  SipaDepositsDeps,
  SipaSlot,
} from "../engine/sipaDeposits"
import { logger } from "../utils/logger"

/** The blob older builds kept every SIPA deposit in, one JSON object keyed by lowercase address. */
export const KEY_SIPA_DEPOSITS = "@obsidion/sipa-deposits/records"

/** Fields older builds wrote that nothing reads. */
const DEAD_FIELDS = ["lastScannedBlock", "unresolvedSweepBlocks", "historyScanned", "lastScanAt"]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A legacy record as this version keeps it, or undefined when it is not one. */
function upgraded(value: unknown): SipaDeposit | undefined {
  if (!isObject(value) || typeof value.sipaAddress !== "string" || typeof value.phase !== "string")
    return undefined
  const { error, ...rest } = value
  const record = Object.fromEntries(
    Object.entries(rest).filter(([field]) => !DEAD_FIELDS.includes(field)),
  ) as unknown as SipaDeposit
  return typeof error === "string" && !record.failure
    ? { ...record, failure: { code: "unknown", detail: error } }
    : record
}

/**
 * The records a `KEY_SIPA_DEPOSITS` blob holds, keyed as this store keys them. A record that is not
 * one is skipped; a blob that does not parse holds none.
 */
export function decodeSipaDeposits(raw: string | undefined): [string, SipaDeposit][] {
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn("[sipaDeposits] the saved deposits do not parse; the chain refills them")
    return []
  }
  if (!isObject(parsed)) {
    logger.warn("[sipaDeposits] the saved deposits are not a record map; the chain refills them")
    return []
  }
  const out: [string, SipaDeposit][] = []
  for (const [key, value] of Object.entries(parsed)) {
    const record = upgraded(value)
    if (record) out.push([sipaDepositId(record.sipaAddress), record])
    else logger.warn(`[sipaDeposits] skipped the saved deposit ${key}: not a deposit record`)
  }
  return out
}

/** The blob older builds kept every namespace's broadcasts in, keyed by lowercase address. */
export const BROADCASTS_STORAGE_KEY = "@obsidion/sipa-broadcasts"

/** What an older build's failure text meant. */
const LEGACY_WAITS: Record<string, SipaBroadcastWait> = {
  "Waiting for unlock": "unlock",
  "Waiting for the tag to register": "registration",
  "Waiting for the balance move": "balanceMove",
}

/** A legacy broadcast's failure text as a wait or a failure. */
function legacyOutcome(text: unknown): Pick<SipaBroadcast, "wait" | "failure"> {
  if (typeof text !== "string") return {}
  const wait = LEGACY_WAITS[text]
  if (wait) return { wait }
  return text === "The network dropped the broadcast"
    ? { failure: { code: "deposit.broadcastDropped" } }
    : { failure: { code: "deposit.broadcastFailed", detail: text } }
}

/**
 * The broadcasts a legacy blob holds for namespace `scope`, as this store keeps them. One that is
 * not a broadcast is skipped; a blob that does not parse holds none.
 */
export function decodeBroadcasts(
  raw: string | undefined,
  scope: string | null,
): [string, SipaBroadcast][] {
  let parsed: unknown
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    logger.warn("[sipaDeposits] the saved broadcasts do not parse")
    return []
  }
  if (!isObject(parsed)) return []
  return Object.values(parsed).flatMap((value): [string, SipaBroadcast][] => {
    if (!isObject(value) || typeof value.address !== "string" || !isObject(value.source)) return []
    if ((value.scope ?? null) !== scope) return []
    const job = Object.fromEntries(
      Object.entries(value).filter(([k]) => !["address", "scope", "lastError"].includes(k)),
    ) as unknown as SipaBroadcast
    return [[sipaDepositId(value.address), { ...job, ...legacyOutcome(value.lastError) }]]
  })
}

/** `record` with a version 2 slot broadcast's `(day, nonce)` moved onto its `slot`. */
function withSlotSource(record: SipaDeposit): SipaDeposit {
  const source = record.broadcast?.source as (BroadcastSource & Partial<SipaSlot>) | undefined
  if (source?.type !== "slot" || source.day === undefined || source.nonce === undefined)
    return record
  const { day, nonce, deployment } = source
  return {
    ...record,
    slot: record.slot ?? { day, nonce, ...(deployment ? { deployment } : {}) },
    broadcast: { ...record.broadcast!, source: { type: "slot" } },
  }
}

/** An address older builds kept outside the records: the view's slot, or a pool entry. */
interface LegacySlot extends SipaSlot {
  address: string
  published: boolean
  broadcastTxHash?: string
  pooled: boolean
}

const isLegacySlot = (v: unknown): v is Omit<LegacySlot, "pooled"> =>
  isObject(v) &&
  typeof v.address === "string" &&
  Number.isInteger(v.day) &&
  Number.isInteger(v.nonce) &&
  typeof v.published === "boolean"

/** The slots and pool entries of older builds' saved values: an entry that is not one is skipped. */
export function decodeSlots(values: readonly string[]): LegacySlot[] {
  return values.flatMap((raw) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    const pooled = Array.isArray(parsed)
    const entries = (pooled ? parsed : [parsed]) as unknown[]
    return entries.flatMap((v) => (isLegacySlot(v) ? [{ ...v, pooled }] : []))
  })
}

/**
 * A held record with what an older build kept of its address: its slot, a landed pool broadcast
 * for a pool entry, and an owed one for an address shown and never published.
 */
function adoptSlot(record: SipaDeposit, legacy: LegacySlot, at: number): SipaDeposit {
  const { day, nonce, deployment } = legacy
  const slot = record.slot ?? { day, nonce, ...(deployment ? { deployment } : {}) }
  if (record.broadcast || (legacy.published && !legacy.pooled)) return { ...record, slot }
  const job: SipaBroadcast = legacy.pooled
    ? {
        kind: "pool",
        source: { type: "slot" },
        state: "landed",
        createdAt: at,
        failures: 0,
      }
    : {
        kind: "deposit",
        source: { type: "slot" },
        state: legacy.broadcastTxHash ? "sent" : "queued",
        createdAt: at,
        shownAt: at,
        failures: 0,
        ...(legacy.broadcastTxHash ? { txHash: legacy.broadcastTxHash } : {}),
      }
  return { ...record, slot, broadcast: job }
}

/**
 * Version 1 carries every legacy record forward: several exist only on this device. Version 2
 * folds this namespace's legacy broadcasts into their records: an owed one exists nowhere else.
 * Version 3 moves each held address's legacy slot or pool entry onto its record.
 */
export async function migrateSipaDeposits(
  from: number | undefined,
  w: Write,
  deps: { db: Database; prefix: string; legacy: SipaDepositsDeps["legacy"] },
): Promise<void> {
  const { db, prefix } = deps
  if (from !== undefined && from !== 1 && from !== 2)
    throw new WalletError("invariant", `sipaDeposits: unknown version ${from}`)
  const held = new Set((await db.range(`${prefix}/`)).map(([key]) => key.slice(prefix.length + 1)))
  const read = async (id: string) => {
    const raw = await w.get(`${prefix}/${id}`)
    return raw === undefined ? undefined : (decodeRecord(raw) as SipaDeposit)
  }
  const save = (record: SipaDeposit) => {
    const id = sipaDepositId(record.sipaAddress)
    held.add(id)
    w.put(`${prefix}/${id}`, encodeRecord(record))
  }
  if (from === undefined) {
    for (const [id, record] of decodeSipaDeposits(await w.get(KEY_SIPA_DEPOSITS)))
      if (!held.has(id)) save(record)
  }
  if (from !== 2 && deps.legacy) {
    const { db: page, scope } = deps.legacy
    for (const [id, job] of decodeBroadcasts(await page.get(BROADCASTS_STORAGE_KEY), scope)) {
      const record = await read(id)
      if (!record?.broadcast) save({ ...(record ?? broadcastStub(id, job)), broadcast: job })
    }
  }
  for (const id of held) {
    const record = await read(id)
    const moved = record && withSlotSource(record)
    if (moved && moved !== record) save(moved)
  }
  const slots = deps.legacy?.slots
  const legacySlots = slots ? decodeSlots((await slots.range("")).map(([, value]) => value)) : []
  const at = Date.now()
  for (const legacy of legacySlots) {
    const record = await read(sipaDepositId(legacy.address))
    if (record) save(adoptSlot(record, legacy, at))
  }
  // Older builds left a landed pool broadcast as it was when its address was handed out: only
  // the saved pool still holds unshown addresses.
  const pooled = new Set(legacySlots.flatMap((s) => (s.pooled ? [sipaDepositId(s.address)] : [])))
  for (const id of held) {
    const record = await read(id)
    const job = record?.broadcast
    if (record && job?.kind === "pool" && job.state === "landed" && !pooled.has(id))
      save({ ...record, broadcast: { ...job, kind: "deposit", shownAt: job.shownAt ?? at } })
  }
}
