import { getAddress, keccak256, type Address, type Hash, type Hex } from "viem"
import type { SIPADepositPhase } from "@obsidion/core/types"
import { logger } from "../utils/logger"
import type { Database, Reads, Write } from "./database"
import { WalletError, type Failure } from "./errors"
import {
  decodeRecord,
  encodeRecord,
  loadRecords,
  persistentStore,
  type RecordSet,
} from "./persistentStore"
import {
  broadcastStub,
  SIPA_DEPOSIT_RECORD_VERSION,
  sipaDepositTransition,
  type SipaDepositEvent,
  type SipaDepositFields,
} from "./sipaDepositTransition"
import type { ReadonlyStore } from "./store"

export type { SIPADepositPhase }
export * from "./sipaDepositTransition"

export type SipaOrigin = {
  sipaFactory: Address
  implementation: Address
  intentHash: Hex
  rollupVersion: string
  resweepable: boolean
} & (
  | { protocol: "legacy-eoa"; recoveryAddress: Address }
  | {
      protocol: "account"
      recoveryAccount: Address
      recoveryCommitment: Hex
      accountFactory: Address
      /** The ForwardingTable the address commits to; its rows route each sweep. */
      forwardingTable: Address
    }
)

/**
 * One claimed sweep of a SIPA. The record's amount fields describe the latest; the ledger keeps
 * every one, since a re-used address is swept again and the export reports each.
 */
export interface SIPASweep {
  inboxIndex: string
  sweepTxHash: Hash
  /** ms epoch of the sweep's L1 block. */
  settledAt?: number
  /** The portal of the row the sweep settled on, and that row's L2 token, where it is claimed. */
  portal?: Address
  l2Token?: string
  /** The row's token: what the sweep credited, and the units of `netAmount` and `fee`. */
  tokenAddress?: Address
  tokenSymbol?: string
  tokenDecimals?: number
  /** The row's sweep fee, raw units of the credited token. */
  fee?: string
  /** Credited on L2, raw units of the credited token. */
  netAmount: string
  /** The L1→L2 message the sweep sent, when the entry carries it. */
  messageKey?: Hex
  /**
   * What the sweep took out of the SIPA, raw units of `fundingTokenDecimals`: every funding
   * transfer it settled. Unset when the sweep tx moved more than one token out.
   */
  grossAmount?: string
  fundingTokenSymbol?: string
  fundingTokenDecimals?: number
}

/** A sweep seen on L1 and not yet claimed: its claim inputs, kept so a later pass claims it without
 *  reading L1 again. Decimal strings for the bigints. */
export interface SIPAPendingSweep {
  inboxIndex: string
  amount: string
  messageKey: Hex
  blockNumber: string
  sweepTxHash: Hash
  /** The portal whose `Deposit` the sweep made, which names its row. Absent on a sweep saved before rows. */
  portal?: Address
  /** What the sweep took out of the SIPA and in which token, once the window it was seen in is gone. */
  grossAmount?: string
  fundingToken?: Address
  /** ms epoch of the sweep's L1 block. */
  sweptAt?: number
  /** The sweep's fee on its row, raw units of the credited token. */
  fee?: string
  /** When the deposit settles once claimed: the sweep's block for history replayed onto the device. */
  settledAt?: number
  /** The deposit's note is already spent, on this device or another: it settles with no claim. */
  spent?: true
}

/** One portal deposit the rail tracks: a SIPA's sweep, or a direct (migration) deposit no SIPA made. */
export interface SipaDeposit {
  /** Counterfactual SIPA address; its lowercase form is the record's id. */
  sipaAddress: Address
  /** The {@link SIPA_DEPOSIT_RECORD_VERSION} the record was written or migrated at; absent is 1. */
  version?: number
  /** The recipient's L2 account — the feed's group identity for SIPA deposits. */
  recipientL2Address: string
  /**
   * The SIPA event's `shared_secret_salt` (Fr hex). Everything else re-derives from it; persisting
   * it lets a claim resume across restarts. It is half the recovery key (the other half is the
   * user's stealth scalar, which is never persisted).
   */
  messageSecret: string
  /** Derived recipient hash (Fr hex) the SIPA is bound to. */
  recipientHash: string
  /** Derived recovery address (the recoverERC20 signer identity). */
  recoveryAddress: string
  origin?: SipaOrigin
  /** L1 chain the SIPA lives on. */
  l1ChainId: number
  /** L2 network the record was created on: see `OnNetwork`. */
  networkId?: string
  /** Decimal display amount (gross before the sweep, net once known). */
  amount: string
  /** Token ticker for display. */
  tokenSymbol: string
  phase: SIPADepositPhase
  /** ms epoch of the L1 funding transfer's block; the record's creation until that is read. */
  startTime: number
  /**
   * Created from a discovered SIPA event with no local record: history replayed onto this device rather
   * than an address it handed out. Such a record gets no fresh-broadcast scan window.
   */
  replayed?: boolean
  /** ms epoch when the record reached a terminal phase. */
  endTime?: number
  /** The resolved name (self-initiated flow), e.g. "alice.oxidestaging.eth". */
  resolvedName?: string
  /**
   * Set when the SIPA is not a plain deposit — the intent its address commits to. `user-op` is a
   * backup passkey rotation's funding, paid to the SIPA that runs the account's user operation.
   */
  intent?: "registration" | "user-op"
  /**
   * Set when no SIPA exists: an upgrade's migration executor deposited straight into the portal under
   * `recipientCommitment`. The record's key is then {@link directDepositKey}, not an L1 address.
   * `expected` is the batch's amount in raw units, when this device sent the batch. The commitment
   * is public, so another sender can deposit under it too: the rail observes the record until it
   * has claimed `expected` in total, and observes a record with no `expected` always. `portal` is
   * the destination portal, from the row of the token that announced the deposit.
   */
  direct?: { recipientCommitment: Hex; executor?: Address; expected?: string; portal?: Address }
  /** L1 token address of the funding transfer. */
  tokenAddress?: Address
  /**
   * The row token unswept funds settle in, when `tokenAddress` is a token the SIPA swaps into it
   * (the mainnet USDC and USDT, into DAI).
   */
  rowToken?: Address
  /** Decimals of `tokenAddress` (6 for the mainnet USDC/USDT swap route, else 18). */
  tokenDecimals?: number
  /** Sweep log values — the claim inputs. Strings for JSON-safe bigints. */
  inboxIndex?: string
  /**
   * Inbox indexes already claimed off this SIPA. A SIPA paid again is swept again once it is
   * published again, and each sweep claims independently — this is its dedup.
   */
  claimedInboxIndexes?: string[]
  /** Every claimed sweep, in inbox order. */
  sweeps?: SIPASweep[]
  /** Net amount forwarded to the portal (gross − fee), raw token units. */
  netAmount?: string
  /** Deductions between the gross and L2 credit, raw token units. */
  fee?: string
  /** Registration fee paid to the beneficiary, raw token units. */
  registrationFee?: string
  /** L1 deploy-and-sweep tx hash. */
  sweepTxHash?: Hash
  /** L1 recoverERC20/recoverETH tx hash. */
  recoveryTxHash?: Hash
  failure?: Failure
  /**
   * The head (decimal string) of the pass that first read this SIPA's whole history. From then on
   * it rides the deployment's cursor.
   */
  observedFrom?: string
  /** A block (decimal string) a failed pass left this SIPA to re-read from. */
  rescanFrom?: string
  /**
   * The sweep whose claim landed and when, ms epoch. Set before the record reads `claimed`. A balance
   * read resolved after it holds the deposit.
   */
  claimLanded?: { inboxIndex: string; at: number }
  /** Sweeps seen and not yet claimed, in inbox order. */
  pendingSweeps?: SIPAPendingSweep[]
  /** ms epoch the rail last asked for this funded, overdue SIPA to be published again. */
  republishAskedAt?: number
  /**
   * The largest balance the rail last observed at the SIPA across its accepted tokens, raw units of
   * the fee token. What the registration tick reads as funded.
   */
  heldBalance?: string
  /**
   * On-chain funding attribution, read from the token's `Transfer(to = sipa)`. The self-initiated
   * flow also stamps `fundingTxHash` from its own receipt, which lands first; the sender address is
   * only ever the log's.
   */
  fundingTxHash?: Hash
  fundingFromAddress?: Address
  /**
   * Ticker of the token the sweep takes: what the funder sent, or the balance the sweep picks
   * when several accepted tokens were sent. `tokenSymbol` is the credited token once swept.
   */
  fundingTokenSymbol?: string
  /**
   * Sender-wallet display identity: the connected wallet on self-initiated deposits, backfilled from
   * `fundingFromAddress` on third-party ones once the funding transfer is observed.
   */
  walletName?: string
  walletAddress?: string
  /** Set on an address this wallet derived for itself. */
  slot?: SipaSlot
  /** The address's broadcast, owed by this wallet until it lands. */
  broadcast?: SipaBroadcast
}

/**
 * `registration`: a name's deposit address. `deposit`: an address handed to the user. `pool`: one
 * broadcast ahead of need, which nobody has seen yet.
 */
export type BroadcastKind = "registration" | "deposit" | "pool"

/** What the executor rebuilds the broadcast from. Nothing secret: the keys re-derive the rest. */
export type BroadcastSource =
  | { type: "registration"; account: string }
  /** A self-derived address: the record's `slot` rebuilds it. */
  | { type: "slot" }
  | { type: "rotation"; owner: string }

/** The `(day, nonce)` a self-derived address comes from; nothing secret, the keys re-derive it. */
export interface SipaSlot {
  day: number
  nonce: number
  /** A pool fill's deployment (`sipaPoolDeployment`): only that deployment's relayer knows it. */
  deployment?: string
}

/**
 * `queued`: owed, and waiting for its turn or its retry time. `proving`: a page is building it.
 * `sent`: the node accepted it; the chain decides. `landed`: included, nothing left to do.
 */
export type BroadcastState = "queued" | "proving" | "sent" | "landed"

/** What a deferred broadcast waits for. */
export type SipaBroadcastWait = "unlock" | "registration" | "balanceMove"

export interface SipaBroadcast {
  kind: BroadcastKind
  source: BroadcastSource
  state: BroadcastState
  /** When it was first owed: the queue's order within a rank. */
  createdAt: number
  /** First shown to the user. */
  shownAt?: number
  /** Funds were seen at the address. */
  fundedAt?: number
  /** Attempts that failed. An interruption or a wait is not one. */
  failures: number
  /** Not run again before this time, ms. */
  retryAt?: number
  txHash?: string
  /** The operation the attempts report through; none for a pool broadcast. */
  operationId?: string
  /** Paid again after landing: only a broadcast mined at or after this L2 block lands it. */
  republishSince?: number
  /** The last attempt's failure. */
  failure?: Failure
  wait?: SipaBroadcastWait
}

/** A record's broadcast with its lowercase address: what an executor runs. */
export type BroadcastJob = SipaBroadcast & { address: string }

/** What owes a broadcast: it starts `queued`, or `sent` when its hash is already known. */
export type OwedBroadcast = Pick<SipaBroadcast, "kind" | "source"> &
  Partial<Pick<SipaBroadcast, "shownAt" | "fundedAt" | "txHash" | "republishSince">>

/** The bridge every version 1 sweep was claimed through: one portal, its L2 token and its token. */
export interface SipaSweepRow {
  portal: Address
  l2Token: string
  token: { address: Address; symbol: string; decimals: number }
}

/** The loaded record at `address`, if any. */
export function selectSipaDeposit(
  { records }: Pick<RecordSet<SipaDeposit>, "records">,
  address: string,
): SipaDeposit | undefined {
  const id = address.toLowerCase()
  return records.find((r) => r.sipaAddress.toLowerCase() === id)
}

/** Whether the rail has claimed every sweep it saw at the address, and at least one. */
export function sipaSweepsReceived(record: SipaDeposit | null | undefined): boolean {
  return (
    record?.phase === "claimed" &&
    !!record.claimedInboxIndexes?.length &&
    !record.pendingSweeps?.length
  )
}

/**
 * The key of a direct deposit's record: an address-shaped value from its commitment. It holds
 * nothing on L1, and no SIPA has it.
 */
export function directDepositKey(recipientCommitment: Hex): Address {
  return getAddress(`0x${keccak256(recipientCommitment.toLowerCase() as Hex).slice(-40)}`)
}

/** The total of the sweeps the rail has claimed off `record`, raw units of their tokens. */
export function claimedSweepsTotal(record: SipaDeposit | null | undefined): bigint {
  const claimed = new Set(record?.claimedInboxIndexes ?? [])
  return (record?.sweeps ?? [])
    .filter((sweep) => claimed.has(sweep.inboxIndex))
    .reduce((sum, sweep) => sum + BigInt(sweep.netAmount), 0n)
}

/**
 * Whether nothing more is expected under a direct deposit's commitment: the rail has claimed
 * every deposit it saw, and in total at least the batch's `expected` amount. A record with no
 * `expected` never settles, since a deposit from another sender can come first.
 */
export function directDepositSettled(record: SipaDeposit | null | undefined): boolean {
  const expected = record?.direct?.expected
  return (
    expected !== undefined &&
    sipaSweepsReceived(record) &&
    claimedSweepsTotal(record) >= BigInt(expected)
  )
}

/**
 * A SIPA the account pays itself, not a deposit from someone else: a backup passkey rotation's
 * funding. The wallet reports it as the account's own move.
 */
export function isAccountMoveSipa(record: Pick<SipaDeposit, "intent">): boolean {
  return record.intent === "user-op"
}

/** The blob older builds kept every SIPA deposit in, one JSON object keyed by lowercase address. */
export const KEY_SIPA_DEPOSITS = "@obsidion/sipa-deposits/records"

const PREFIX = "acct/sipaDeposits"

/** A record's id: its lowercase address. */
export const sipaDepositId = (address: string) => address.toLowerCase()

/** Where a pass keeps the block it read `recipient`'s SIPAs through at `portal`. */
export const sipaCursorKey = (portal: string, recipient: string) =>
  `acct/sipaCursor/${portal.toLowerCase()}/${recipient.toLowerCase()}`

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

/**
 * The deposits a database no deposit store is open on holds, such as a retired rollup's: this store's
 * records, then the blob's records it lacks.
 */
export function storedSipaDeposits(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): SipaDeposit[] {
  const out = new Map<string, SipaDeposit>()
  for (const k of db.keys(`${PREFIX}/`)) {
    const raw = db.get(k)
    if (raw === null || raw === undefined) continue
    const record = decodeRecord(raw) as SipaDeposit
    if (typeof record?.sipaAddress === "string") out.set(sipaDepositId(record.sipaAddress), record)
  }
  for (const [id, record] of decodeSipaDeposits(db.get(KEY_SIPA_DEPOSITS) ?? undefined)) {
    if (!out.has(id)) out.set(id, record)
  }
  return [...out.values()]
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

export interface SipaDepositsDeps {
  /** The account's database. */
  db: Database
  /**
   * The page's database, where older builds kept every namespace's broadcasts under
   * `BROADCASTS_STORAGE_KEY`, and the namespace's id (`null` for a page with no account).
   */
  legacy?: {
    db: Pick<Reads, "get">
    scope: string | null
    /** Where older builds kept the address each view held and the pool, one value per key. */
    slots?: Pick<Database, "range">
  }
  /** Whether the namespace is an account's: a page with no account takes no registration seed. */
  account: boolean
  /** Hears a registration address show its first funds, once the write that shows them commits. */
  funded?(): void
}

/** The address holds funds, or a sweep took them. */
const showsFunds = (r: SipaDeposit | undefined) =>
  /[1-9]/.test(r?.heldBalance ?? "") || (r?.sweeps?.length ?? 0) > 0

/**
 * The account's SIPA deposits, one record each, keyed by lowercase address. A record changes only
 * through `sipaDepositTransition`. Every record loads; reads hold saved records only. A write without
 * `w` commits on its own and resolves once saved; with one, it joins that transaction.
 */
export interface SipaDeposits {
  readonly view: ReadonlyStore<RecordSet<SipaDeposit>>
  readonly ready: Promise<void>
  get(address: string, w?: Write): Promise<SipaDeposit | undefined>
  /** `recipient`'s records, read once. */
  byRecipient(recipient: string): Promise<readonly SipaDeposit[]>
  /** The record when `event` changed it; undefined when it did not, or removed it. */
  apply(address: string, event: SipaDepositEvent, w?: Write): Promise<SipaDeposit | undefined>
  /** Applies each event to its record in order, in one transaction. */
  applyAll(
    events: readonly (readonly [string, SipaDepositEvent])[],
    w?: Write,
  ): Promise<SipaDeposit[]>
  /** Saves a record read off another database unless one holds its address; whether it did. */
  adopt(record: SipaDepositFields): Promise<boolean>
  /** Stamps version 1 records of `networkId` with the one bridge their sweeps settled on. */
  stampSweepRows(networkId: string, pinned: SipaSweepRow): Promise<SipaDeposit[]>
  /** Owes the address's broadcast; an address with no record gets one holding just the broadcast. */
  oweBroadcast(address: string, owed: OwedBroadcast): Promise<SipaDeposit | undefined>
  /**
   * Hands out the first of `candidates` still in the pool, in one write: it reads shown from then
   * on, so no other view takes it.
   */
  handOut(candidates: readonly string[], at: number): Promise<SipaDeposit | undefined>
}

export function createSipaDeposits(deps: SipaDepositsDeps): SipaDeposits {
  const { db } = deps
  /**
   * Version 1 carries every legacy record forward: several exist only on this device. Version 2
   * folds this namespace's legacy broadcasts into their records: an owed one exists nowhere else.
   * Version 3 moves each held address's legacy slot or pool entry onto its record.
   */
  const migrate = async (from: number | undefined, w: Write): Promise<void> => {
    if (from !== undefined && from !== 1 && from !== 2)
      throw new WalletError("invariant", `sipaDeposits: unknown version ${from}`)
    const held = new Set(
      (await db.range(`${PREFIX}/`)).map(([key]) => key.slice(PREFIX.length + 1)),
    )
    const read = async (id: string) => {
      const raw = await w.get(`${PREFIX}/${id}`)
      return raw === undefined ? undefined : (decodeRecord(raw) as SipaDeposit)
    }
    const save = (record: SipaDeposit) => {
      const id = sipaDepositId(record.sipaAddress)
      held.add(id)
      w.put(`${PREFIX}/${id}`, encodeRecord(record))
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
  const store = persistentStore<SipaDeposit, "recipient">(db, {
    prefix: PREFIX,
    version: 3,
    id: (record) => sipaDepositId(record.sipaAddress),
    migrate,
    indexes: {
      recipient: (record) =>
        record.recipientL2Address ? [record.recipientL2Address.toLowerCase()] : [],
    },
    load: "all",
  })
  /** Keys of registration records a staged write takes to their first funds. */
  const firstFunds = new Set<string>()
  const { funded } = deps
  if (funded)
    db.onCommit((ops) => {
      for (const [key, raw] of ops) {
        if (!firstFunds.delete(key) || raw === null) continue
        if (showsFunds(decodeRecord(raw) as SipaDeposit)) funded()
      }
    })
  const writing = async <T>(w: Write | undefined, fn: (w: Write) => Promise<T>): Promise<T> => {
    if (w) return fn(w)
    await store.ready
    return db.write(fn)
  }
  const applyAll: SipaDeposits["applyAll"] = (events, w) =>
    writing(w, async (w) => {
      const changed: SipaDeposit[] = []
      const now = Date.now()
      for (const [address, event] of events) {
        if (!deps.account && event.type === "seeded")
          throw new WalletError(
            "wallet.notReady",
            "sipaDeposits: no account to file a registration seed under",
          )
        const id = sipaDepositId(address)
        const record = await store.get(id, w)
        const next = sipaDepositTransition(record, event, now)
        if (next === null) await store.remove(id, w)
        if (!next) continue
        if (next.intent === "registration" && !showsFunds(record) && showsFunds(next))
          firstFunds.add(`${PREFIX}/${id}`)
        await store.put(next, w)
        changed.push(next)
      }
      return changed
    })

  return {
    view: store.view,
    ready: store.ready,
    get: (address, w) => store.get(sipaDepositId(address), w),
    byRecipient: (recipient) => loadRecords(store.query("recipient", recipient.toLowerCase())),
    applyAll,
    async apply(address, event, w) {
      const [next] = await applyAll([[address, event]], w)
      return next
    },
    adopt: (record) =>
      writing(undefined, async (w) => {
        if (await store.get(sipaDepositId(record.sipaAddress), w)) return false
        await applyAll([[record.sipaAddress, { type: "imported", fields: record }]], w)
        return true
      }),
    async oweBroadcast(address, owed) {
      const [next] = await applyAll([
        [address, { type: "broadcastOwed", address, owed, at: Date.now() }],
      ])
      return next
    },
    handOut: (candidates, at) =>
      writing(undefined, async (w) => {
        for (const address of candidates) {
          if ((await store.get(sipaDepositId(address), w))?.broadcast?.kind !== "pool") continue
          const [shown] = await applyAll([[address, { type: "shown", at }]], w)
          return shown
        }
        return undefined
      }),
    async stampSweepRows(networkId, pinned) {
      const due = (await loadRecords(store.view)).filter(
        (r) => (r.version ?? 1) < SIPA_DEPOSIT_RECORD_VERSION,
      )
      if (due.length === 0) return []
      return applyAll(
        due.map((r) => [r.sipaAddress, { type: "sweepRowsStamped", networkId, pinned }] as const),
      )
    },
  }
}
