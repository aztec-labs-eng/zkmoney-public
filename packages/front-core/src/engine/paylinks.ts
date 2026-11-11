import { DEFAULT_CONTRACTS, PaylinkActionEnum, QueueStatus } from "@obsidion/core/constants"
import { decodePaylinkInline, type PaylinkParams } from "@obsidion/sdk"
import { keccak256, toBytes } from "viem"
import type { PaylinkTransaction, Transaction } from "../types/transactions"
import type { Database, Write } from "./database"
import { WalletError } from "./errors"
import { operationIndex, withOperation, type Funding, type OperationIndex } from "./operations"
import type { OperationRecord } from "./operationTransition"
import { paylinkTransition, type PaylinkEvent, type PaylinkRecord } from "./paylinkTransition"
import {
  decodeRecord,
  encodeRecord,
  loadRecords,
  persistentStore,
  timeKey,
  type IndexRange,
  type RecordSet,
} from "./persistentStore"
import type { ReadonlyStore } from "./store"
import { carryFailedFundings } from "../storageMigrations/paylinks"

/** The escrow's recovery key: a hash of its contract type and secret, so no key holds the secret. */
export function linkIdentity(paylinkType: string, secret: string): string {
  return keccak256(toBytes(["paylink-withdrawal-v2", paylinkType, secret].join(":")))
}

const typeOf = (flavor: PaylinkRecord["flavor"]) =>
  flavor === "email" ? DEFAULT_CONTRACTS.paylinkEmail : DEFAULT_CONTRACTS.paylinkDirect

/** The rollup a link's fragment names: its L1 chain id and rollup version. */
export const linkRollup = (params: Pick<PaylinkParams, "chainId" | "rollupVersion">) =>
  `${params.chainId}:${params.rollupVersion}`

/**
 * The record id of the `flavor` link with this secret made on `rollup`. A secret derives from the
 * master secret, the day and the slot, so two rollups' links can share one; the rollup tells them
 * apart.
 */
export const linkId = (flavor: PaylinkRecord["flavor"], secret: string, rollup: string) =>
  keccak256(toBytes(["paylink-record-v1", typeOf(flavor), secret, rollup].join(":")))

/** The record id of the link a fragment names. */
export const linkIdFor = (params: PaylinkParams) =>
  linkId(
    params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct",
    params.secret.toString(),
    linkRollup(params),
  )

/**
 * A link's record id: its rollup is the one its URL names, else, for a URL this build cannot read,
 * the one its record is stamped with. No fragment lookup reaches a link of the second kind.
 */
export function linkIdOf(
  link: Pick<PaylinkRecord, "flavor" | "payToEmailSecret" | "paylink" | "networkId">,
): string {
  const params = link.paylink ? urlParams(link.paylink) : undefined
  const rollup = params ? linkRollup(params) : link.networkId?.toLowerCase() ?? ""
  return linkId(link.flavor, link.payToEmailSecret, rollup)
}

export type PaylinkIndex = "hash" | "open" | "claimed" | "operation"

const PREFIX = "acct/paylinks"
const TRANSFERS = "acct/transfers"
/** The `open` index value of a link still in escrow. */
export const OPEN = "open"
/** The transfers store's value for a row in escrow, in the index it keeps for builds before this one. */
const OPEN_ROW = "1"

const lower = (value: string | undefined) =>
  value && !value.includes("/") ? [value.toLowerCase()] : []

const INDEXES: Record<PaylinkIndex, (link: PaylinkRecord) => readonly string[]> = {
  hash: (link) => [...new Set([...lower(link.txHash), ...lower(link.refundTxHash)])],
  open: (link) => (!link.isClaimed && !link.isRefunded && !link.isMigrated ? [OPEN] : []),
  claimed: (link) => (link.claimedAt !== undefined ? [timeKey(link.claimedAt)] : []),
  operation: (link) => lower(link.operationId),
}

/** The fields that leave a transfer row for the link's record. */
const LINK_FIELDS = [
  "payToEmailSecret",
  "fallbackSecret",
  "obsidionAccountAddress",
  "partialAddress",
  "from",
  "to",
  "memo",
  "fromClaimable",
  "untilClaimable",
  "refundableUntil",
  "paylink",
  "isClaimed",
  "claimedAt",
  "claimedBy",
  "isRefunded",
  "refundTxHash",
  "refundKind",
  "isMigrated",
] as const

type CreatedRow = PaylinkTransaction & { payToEmailSecret: string }

/** The link a stored full URL names, or undefined when it names none. */
function urlParams(url: string): PaylinkParams | undefined {
  try {
    return decodePaylinkInline(url.slice(url.indexOf("#") + 1))
  } catch {
    // A row from an older build with a malformed URL holds no link to move.
    return undefined
  }
}

/**
 * A created link's row, its secret and flavor read from its URL when an older build saved only
 * the URL. Undefined for any other row.
 */
function createdLink(row: Transaction): CreatedRow | undefined {
  const tx = row as PaylinkTransaction
  if (tx.emailPaymentAction !== PaylinkActionEnum.PAY) return undefined
  if (tx.payToEmailSecret) return tx as CreatedRow
  const params = tx.paylink ? urlParams(tx.paylink) : undefined
  if (!params) return undefined
  // The URL names its contract; a flavor on the row may be the legacy reader's default.
  const flavor = params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
  return { ...tx, payToEmailSecret: params.secret.toString(), flavor }
}

/** The link a created link's row holds, under `id`. */
export function recordOf(row: CreatedRow, id = linkIdOf(row)): PaylinkRecord {
  const link: Record<string, unknown> = {
    id,
    timestamp: row.timestamp,
    amountAtomic: row.amountAtomic,
    flavor: row.flavor,
  }
  const carried = [
    "operationId",
    "txHash",
    "networkId",
    "kind",
    "token",
    "tokenAddress",
    "reorgEpoch",
  ]
  for (const field of [...carried, ...LINK_FIELDS]) {
    const value = (row as Record<string, unknown>)[field]
    if (value !== undefined) link[field] = value
  }
  return link as PaylinkRecord
}

/** The transfer row without its link: the funding transfer, which `transfers` keeps. */
export function fundingOf<T extends Transaction>(row: T): T {
  const out: Record<string, unknown> = { ...row }
  for (const field of LINK_FIELDS) delete out[field]
  return out as T
}

/** `kept` with what `other` knows that `kept` does not. */
const merged = (kept: PaylinkRecord, other: PaylinkRecord): PaylinkRecord =>
  ({
    ...other,
    ...Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)),
  } as PaylinkRecord)

const recordKey = (id: string) => `${PREFIX}/${id}`

const entries = (link: PaylinkRecord) =>
  (Object.entries(INDEXES) as [PaylinkIndex, typeof INDEXES.hash][]).flatMap(([index, values]) =>
    values(link).map((value) => `${PREFIX}.i/${index}/${value}/${link.id}`),
  )

/** Stages a record over `before` with its index entries, as the store's own put would. */
function stage(w: Write, link: PaylinkRecord, before?: PaylinkRecord): void {
  w.put(recordKey(link.id), encodeRecord(link))
  const next = new Set(entries(link))
  for (const key of before ? entries(before) : []) if (!next.has(key)) w.remove(key)
  for (const key of next) w.put(key, "")
}

/**
 * Files each link among `rows` under its identity. A link already filed keeps what it holds and
 * takes only what it lacks, so no field leaves a row without reaching the record.
 */
async function file(w: Write, rows: readonly Transaction[]): Promise<Set<string>> {
  const links = new Map<string, PaylinkRecord>()
  const created = rows.flatMap((r) => createdLink(r) ?? [])
  for (const row of created) {
    const link = recordOf(row)
    const seen = links.get(link.id)
    links.set(link.id, seen ? merged(seen, link) : link)
  }
  const ids = [...links.keys()]
  await carryFailedFundings(w, created)
  const saved = await w.getMany(ids.map(recordKey))
  ids.forEach((id, i) => {
    const raw = saved[i]
    const before = raw === undefined ? undefined : (decodeRecord(raw) as PaylinkRecord)
    const link = before ? merged(before, links.get(id)!) : links.get(id)!
    if (!before || encodeRecord(link) !== raw) stage(w, link, before)
  })
  return new Set(ids)
}

/**
 * Moves every created link out of the account's transfer rows into its record, in `w`. A link is
 * filed before its row loses the fields, in the same write, so a secret is never in neither place.
 * Idempotent: a filed link is kept and a stripped row is left. `ids` are the transfer rows to read
 * through `w`, which sees what the write staged. The legacy blob is never edited.
 */
export async function moveLinksOut(w: Write, ids: readonly string[]): Promise<void> {
  const raws = await w.getMany(ids.map((id) => `${TRANSFERS}/${id}`))
  const rows = raws.flatMap((raw) => (raw === undefined ? [] : [decodeRecord(raw) as Transaction]))
  await file(w, rows)
  for (const row of rows.flatMap((r) => createdLink(r) ?? [])) {
    w.put(`${TRANSFERS}/${row.id}`, encodeRecord(fundingOf(row)))
    // The rows' own index entries that name the link: its secret's, its escrow's and its claim's.
    const index = `${TRANSFERS}.i`
    w.remove(`${index}/link/${row.payToEmailSecret.toLowerCase()}/${row.id}`)
    w.remove(`${index}/open/${OPEN_ROW}/${row.id}`)
    if (row.claimedAt !== undefined)
      w.remove(`${index}/claimed/${timeKey(row.claimedAt)}/${row.id}`)
    if (row.refundTxHash && row.refundTxHash.toLowerCase() !== row.txHash.toLowerCase())
      w.remove(`${index}/hash/${row.refundTxHash.toLowerCase()}/${row.id}`)
  }
}

const isKey = (key: string | undefined): key is string => !!key

/** The hashes and operation ids of `links`' funding transfers. */
export const fundingKeys = (links: readonly PaylinkRecord[]): ReadonlySet<string> =>
  new Set(links.flatMap((l) => [l.txHash && l.txHash.toLowerCase(), l.operationId].filter(isKey)))

/** Whether `tx` is the funding transfer of a link `funded` names, by hash or by operation. */
export const isLinkFunding = (tx: Transaction, funded: ReadonlySet<string>) =>
  (!!tx.txHash && funded.has(tx.txHash.toLowerCase())) ||
  (!!tx.operationId && funded.has(tx.operationId))

export interface Paylinks {
  readonly ready: Promise<void>
  /** Every link: a feed joins them to whichever rows it lists. */
  readonly view: ReadonlyStore<RecordSet<PaylinkRecord>>
  where(index: PaylinkIndex, at: string | IndexRange): ReadonlyStore<RecordSet<PaylinkRecord>>
  get(id: string, w?: Write): Promise<PaylinkRecord | undefined>
  /** The link funded, or refunded, by this transaction. */
  byHash(txHash: string, w?: Write): Promise<PaylinkRecord | undefined>
  /** Drops a link no transaction funded, in the write that reads its hash. */
  remove(id: string, w: Write): Promise<void>
  /** Files a link made or rebuilt here; one already filed keeps what it holds. */
  put(link: PaylinkRecord, w?: Write): Promise<void>
  /** Applies `event` through `paylinkTransition`; resolves to the new record, or undefined. */
  apply(id: string, event: PaylinkEvent, w?: Write): Promise<PaylinkRecord | undefined>
}

/**
 * The account's created links: the chain cannot give back a link no transfer announced, nor who
 * claimed one. The transfers open moves them out of its rows, or out of the legacy blob, so this
 * store opens after it: a read never finds it empty before the move lands, and fails with it.
 */
export function createPaylinks({
  db,
  transfers,
}: {
  db: Database
  transfers: { ready: Promise<void> }
}): Paylinks {
  const store = persistentStore<PaylinkRecord, PaylinkIndex>(db, {
    prefix: PREFIX,
    version: 1,
    id: (link) => link.id,
    indexes: INDEXES,
    load: "all",
    after: transfers.ready,
    async migrate(from) {
      if (from !== undefined)
        throw new WalletError("invariant", `paylinks: unknown version ${from}`)
    },
  })
  return {
    ready: store.ready,
    view: store.view,
    where: (index, at) => store.where(index, at),
    get: (id, w) => store.get(id, w),
    async byHash(txHash, w) {
      const hash = txHash.toLowerCase()
      const ids = (await loadRecords(store.where("hash", hash))).map((link) => link.id)
      const links = await Promise.all(ids.map((id) => store.get(id, w)))
      return links.find((link) => link && INDEXES.hash(link).includes(hash))
    },
    async remove(id, w) {
      const link = await store.get(id, w)
      if (link?.txHash) throw new WalletError("invariant", "paylinks: a funded link is kept")
      await store.remove(id, w)
    },
    async put(link, w) {
      await store.apply(link.id, (saved) => (saved ? undefined : link), w)
    },
    apply: (id, event, w) =>
      store.apply(id, (link) => (link ? paylinkTransition(link, event) : undefined), w),
  }
}

const STATUS: Record<Funding, Pick<Transaction, "status" | "detailedStatus">> = {
  unsent: { status: "failed", detailedStatus: QueueStatus.FAILED },
  local: { status: "pending", detailedStatus: QueueStatus.PENDING },
  sent: { status: "pending", detailedStatus: QueueStatus.MINING },
  settled: { status: "success", detailedStatus: QueueStatus.SUCCESS },
  failed: { status: "failed", detailedStatus: QueueStatus.FAILED },
}

/** The funding row's fields a link's row shows in that format. */
const ROW_FIELDS = [
  "status",
  "detailedStatus",
  "progress",
  "startTime",
  "endTime",
  "failure",
  "tier",
  "blockNumber",
  "blockHash",
] as const

/**
 * `rows` in the format older builds kept, which other rollups' readers take: each link as its
 * funding row, its status from its operation, else from its funding row among `rows`.
 */
export function legacyLinkRows(
  rows: readonly Transaction[],
  links: readonly PaylinkRecord[],
  ops: OperationIndex,
): Transaction[] {
  const byHash = new Map(links.flatMap((l) => (l.txHash ? [[l.txHash.toLowerCase(), l]] : [])))
  const shown = new Set<string>()
  const linked = (link: PaylinkRecord, row?: Transaction): Transaction => {
    shown.add(link.id)
    const { op, funding } = withOperation(link, ops)
    const kept = row
      ? Object.fromEntries(ROW_FIELDS.flatMap((f) => (row[f] === undefined ? [] : [[f, row[f]]])))
      : {}
    const status = op || !row ? { ...kept, ...STATUS[funding], progress: 100 } : kept
    return {
      ...link,
      ...status,
      id: row?.id ?? (link.txHash ? link.txHash.toLowerCase() : link.id),
      txHash: link.txHash ?? "",
      action: PaylinkActionEnum.PAY,
      emailPaymentAction: PaylinkActionEnum.PAY,
    } as PaylinkTransaction
  }
  const out = rows.map((row) => {
    const link = row.txHash ? byHash.get(row.txHash.toLowerCase()) : undefined
    return link && !shown.has(link.id) ? linked(link, row) : row
  })
  return [...out, ...links.filter((link) => !shown.has(link.id)).map((link) => linked(link))]
}

/** Every transfer row with every link folded in, in {@link legacyLinkRows}' format, read once. */
export async function linkedActivity(
  transfers: { all(): Promise<readonly Transaction[]> },
  paylinks: Pick<Paylinks, "view">,
  operations: { view: ReadonlyStore<RecordSet<OperationRecord>> },
): Promise<Transaction[]> {
  const [rows, links, ops] = await Promise.all([
    transfers.all(),
    loadRecords(paylinks.view),
    loadRecords(operations.view),
  ])
  return legacyLinkRows(rows, links, operationIndex(ops))
}
