/**
 * The scan half of the SIPA pipeline: what the chain says about each of a recipient's SIPAs, saved
 * as record events in one write with the cursor that covers them. The claim half (`sipaClaim.ts`)
 * claims the sweeps this one leaves pending, with no L1 read of its own.
 *
 *   1. read the recipient's `SIPA` events (`shared_secret_salt` + `resweepable`) off each row's L2
 *      token, when `discover` is set (it takes the PXE),
 *   2. per event, derive the recipient commitment + recoveryAddress and compute the SIPA address
 *      offline,
 *   3. observe every SIPA at once (`observeSipas`): the portal deposits its sweeps made, which carry
 *      the claim inputs and the L1→L2 message key, its transfers in and out, and its holdings — a
 *      fixed number of requests however many SIPAs,
 *   4. per unclaimed sweep, save its claim inputs, its time and its fee on the record.
 *
 * The first `Transfer(to = sipa)` stamps the funding attribution (funder address + tx) and fires
 * the deposit-attested contact hook.
 *
 * Every known SIPA is observed every pass, settled or not, since a claimed SIPA can be paid again;
 * claims dedup by inbox index. The relayer sweeps an address once per publish, so new funds on a
 * claimed SIPA reopen its record and owe its broadcast again, as does a sweep the relayer left
 * overdue; an address that is not resweepable can only be recovered. A funded SIPA whose balance
 * is at or below the deposit floor — the relayer's sweep fee — can never be swept, so it flips to
 * `recoverable`, surfacing the `recoverERC20` exit.
 *
 * A SIPA reads its whole history once, then rides the deployment's cursor: each pass reads only the
 * blocks since the last. Per-event failures are isolated: one bad SIPA must not stall the rest.
 */

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { keccak256 } from "@aztec-labs/foundation/crypto/keccak"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { formatUnits, type Address, type Hex, type PublicClient } from "viem"
import type { OxideEnvTuple, RegistrationSchedule, SipaGeneration } from "@obsidion/core/types"
import { sipaGenerations } from "@obsidion/core/oxide"
import { registrationFloor } from "@obsidion/core/constants"
import {
  directAnnouncementIntentHash,
  fetchSipaEvents,
  readBlessedImplementations,
  readBlockTimeMs,
  readDepositFee,
  readDepositSIPAImplementation,
  readRegistrationSIPAImplementation,
  readSipaCloneArgs,
  readSipaCloneImplementation,
  readSipaDepositsConsumed,
  readSipaIntent,
  readSweepEmitters,
  type PortalDeposit,
  type SipaEvent,
  type TokenTransfer,
} from "@obsidion/sdk"
import { logger } from "../utils/logger"
import { bestEffort, WalletError } from "../engine/errors"

import { SipaIntent } from "@oxide/l1-contracts"
import { computeSIPAAddress as computeAccountSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { computeSIPAAddress } from "../core/services/deposits/sipa/sipaAddress"
import {
  deploymentSipaRoute,
  sipaIntentName,
  sipaRecordIntent,
  sipaRecordIntentOf,
  sipaRecordRoute,
} from "./sipaRoute"
import {
  sipaDefaultRow,
  sipaIntentRows,
  sipaRowByFunding,
  sipaRowByL2Token,
  sipaRowCredit,
  sipaRowFundingTokens,
  sipaSweepRow,
  type SipaRow,
} from "./sipaRows"
import {
  firstFunding,
  NATIVE_ETH,
  inRowUnits,
  readSipaFunding,
  sweptFunding,
  type SipaFundingToken,
} from "./sipaFunding"
import { observeSipas, type ObservedSweep, type ObservedSipa } from "./sipaObservation"
import {
  resolverPaymentFields,
  selfDeployment,
  type ResolverCandidate,
  type SipaDeployment,
} from "./resolverPayments"
import {
  computeStealthRecipientHash,
  deriveRecoveryAddress,
  type SipaK1Point,
} from "../core/services/deposits/sipa/stealth"
import {
  directDepositKey,
  directDepositSettled,
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  maybeMisfiled,
  sipaCursorKey,
  sipaSetsKey,
  sipaDepositId,
  sipaDepositTransition,
  sipaSweepFields,
  type SipaDepositEvent,
  type SipaDepositFields,
  type SipaDeposit,
  type SipaDeposits,
  type SipaObservation,
  type SIPAPendingSweep,
  type SIPASweep,
} from "../engine/sipaDeposits"
import type { Database } from "../engine/database"

/**
 * Overlap re-read on a resumed scan, so a `Sweep` cannot fall between two windows when
 * the head it was measured against is reorged away. Re-reading a claimed sweep costs
 * nothing (inbox-index dedup); missing one strands the deposit.
 */
const SCAN_REORG_OVERLAP_BLOCKS = 128n

/** How long a funded, sweepable SIPA may wait for the relayer before it is published again. */
export const SWEEP_OVERDUE_MS = 60 * 60_000

/** How often an overdue SIPA is published again while it stays unswept. */
export const REPUBLISH_INTERVAL_MS = 24 * 60 * 60_000

/** How long a fresh SIPA counts as in flight, so the caller keeps its fast cadence. */
const FRESH_WINDOW_MS = 10 * 60_000

/** The look-back a SIPA's first read takes when the caller cannot say where its history starts. */
const SIPA_DEFAULT_LOOKBACK_BLOCKS = 50_000n

/**
 * Whether `record`'s next event is imminent: a sweep or settlement in flight, or a fresh address.
 * A missing record is an event discovered just now, which always is; a replayed one is history.
 */
function isInFlight(record: SipaDeposit | null, now: number): boolean {
  if (!record) return true
  // A sweep or an L1->L2 settlement is in flight; both land in minutes.
  if (record.phase === "sweeping" || record.phase === "pendingClaim") return true
  if (isSettledSipaPhase(record.phase)) return false
  if (record.replayed) return false
  return now - record.startTime < FRESH_WINDOW_MS
}

/** The funder proven by the on-chain funding transfer — the legacy gateway hook's shape. */
export interface SipaFundingWalletDetected {
  address: Address
  walletName?: string
  lastUsedAt?: number
}

/**
 * What a wallet can say about a registration SIPA's pricing:
 *
 * - a `RegistrationSchedule` — ours, and its sweep is priced against these amounts;
 * - `"unsweepable"` — ours, and no schedule can ever sweep it (the controller pays exactly the fee
 *   the address commits to), so any balance there is recoverable;
 * - `null` — ours, schedule not in hand; hold the phase for a pass that can price it;
 * - `undefined` — not ours: a plain deposit, classified on the fee and the cap alone.
 */
export type RegistrationScheduleAnswer = RegistrationSchedule | "unsweepable" | null | undefined

export interface SipaScanDeps {
  publicClient: PublicClient
  /** Reads the recipient's `SIPA` events off the token. */
  wallet: Pick<Wallet, "getPrivateEvents">
  /**
   * Finds the pending sweeps whose deposits were already spent, so they never read as arriving, and
   * the L2 block a broadcast owed again must land from.
   */
  node: Pick<AztecNode, "findLeavesIndexes" | "getBlockNumber">
  masterNullifierHidingKey: GrumpkinScalar
  /**
   * Which of `messageKeys` the chain consumed on `l2Token`, in order. Defaults to the node's
   * nullifier lookup under `masterNullifierHidingKey`.
   */
  readConsumed?: (l2Token: AztecAddress, messageKeys: readonly Hex[]) => Promise<boolean[]>
  /**
   * Reads the recipient's `SIPA` events on L2, which takes the PXE. Without it the pass reads L1
   * alone: the records it holds, and only the head while the head has not passed the cursor.
   */
  discover: boolean
  /** The pass reads the recipient's records once and commits its events in one transaction. */
  store: Pick<SipaDeposits, "byRecipient" | "get" | "applyAll">
  /** The store's database: each portal's cursor commits with the events it covers. */
  db: Pick<Database, "get" | "write">
  tuple: OxideEnvTuple
  /** The recipient account this PXE discovers events for. */
  recipient: AztecAddress
  /** The user's stealth public key (`deriveStealthKey(masterSecret).publicKey`). */
  stealthPublicKey: SipaK1Point
  recoveryAccount: Address
  /**
   * The rows of the pinned table the account's SIPAs settle on (`sipaRows`). Events are read on each
   * row's L2 token, each sweep is claimed through its own row, and a SIPA's funding is priced on the
   * row each token settles on.
   */
  rows: readonly SipaRow[]
  /** A row portal's `TX_AMOUNT_CAP()`. */
  txAmountCap: (row: SipaRow) => Promise<bigint>
  l1ChainId: number
  /** The wallet's network, stamped on the records the pass creates. */
  networkId: string
  /** Addresses the resolver could have handed out with no record yet, read with the holdings. */
  resolverCandidates?: readonly ResolverCandidate[]
  /** This account's own addresses past each day's floor in `salts` (`SELF_SLOTS`), read likewise. */
  selfCandidates?: (
    deployment: SipaDeployment,
    records: readonly SipaDeposit[],
    salts: ReadonlySet<string>,
  ) => Promise<readonly ResolverCandidate[]>
  /**
   * Fired once per SIPA when funding attribution first lands — the app-level
   * hook for saving deposit-attested contacts. Wallet identity fields are set
   * only when the funder matches the record's connected-session wallet.
   */
  onFundingWalletDetected?: (params: SipaFundingWalletDetected) => Promise<void>
  /**
   * The schedule a registration SIPA's sweep is priced against, for the addresses this wallet
   * registered. Without it a deposit short of the schedule's floor reads as sweepable and is
   * stamped with a credit the chain will never pay.
   */
  registrationScheduleFor?: (sipa: Address) => RegistrationScheduleAnswer
  /**
   * The first L1 block a deposit to this account can sit in. A SIPA scans from here once: when it
   * has never been scanned, and when a replayed deposit is still unfunded after the default
   * look-back. Without it those scans take the look-back, which misses an older deposit.
   */
  historyStartBlock?: (head: bigint) => Promise<bigint>
  /**
   * False for a pass over another account's history: it owes no broadcast again, so a claimed SIPA
   * paid again stays claimed for a pass that can owe it.
   */
  republishes?: boolean
  /** Ends the pass at its next step, before it commits. */
  signal?: AbortSignal
}

/** Ends an aborted pass before its next step, so it commits nothing. */
export function stopIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw new WalletError("aborted", `${label} aborted`)
}

export interface SipaScanResult {
  /** Distinct SIPAs discovered from `SIPA` events this run. */
  discovered: number
  /**
   * SIPAs with a sweep or settlement in flight, or freshly handed out. Zero means nothing is
   * expected to change soon and the caller can poll slowly.
   */
  active: number
  /** Sweeps the pass left for the claim half. */
  pendingSettlement: number
  /** SIPAs stuck under the fee floor — recoverERC20 is the exit. */
  recoverable: number
  /** Events or SIPAs that failed this run (isolated; retried next pass). */
  failed: number
  /**
   * The pass read everything it should. False when anything failed, the history start did not
   * read, a stray was adopted (its history is read next pass), the pass did not save, or a
   * step gave up and left its work to a later pass.
   */
  complete: boolean
  /** It found events with no record here: history replayed onto this device. */
  replaying: boolean
  /**
   * Resolver and own addresses found funded and recorded: the next pass reads them, and the caller
   * wakes the broadcasts they owe.
   */
  resolverFunded: number
  /** SIPAs the saved pass found newly funded or newly swept. */
  found: number
  /** Broadcasts the saved pass owes again: the caller wakes the broadcasts. */
  republished: number
  /** The head's time, ms epoch, when the pass read balances: the resolver's days follow it. */
  chainTime?: number
}

export async function scanSipaDeposits(callerDeps: SipaScanDeps): Promise<SipaScanResult> {
  const recipient = callerDeps.recipient.toString()
  const live = () => stopIfAborted(callerDeps.signal, "sipaScan")
  live()
  const startRecords = await callerDeps.store.byRecipient(recipient)
  const deps: PassDeps = {
    ...callerDeps,
    publicClient: passClient(callerDeps.publicClient),
    store: workingSet(startRecords),
    saved: callerDeps.store,
  }
  const { tuple } = deps
  if (!tuple.sipaFactory || !deps.rows.length) {
    throw new WalletError("config.invalid", "the manifest lacks the SIPA factory or table rows")
  }

  const result: SipaScanResult = {
    discovered: 0,
    active: 0,
    pendingSettlement: 0,
    recoverable: 0,
    failed: 0,
    complete: false,
    replaying: false,
    resolverFunded: 0,
    found: 0,
    republished: 0,
  }

  // A received deposit is the deposit intent, so its clone delegates to the factory's deposit
  // implementation; the offline address derivation needs it. The factory's pointer is read rather
  // than the tuple's `depositSIPAImplementation` on purpose: the pointer is what the deposit-address
  // side sent the payer to. Retired generations are the historic probe's job, and it must not read
  // this pointer at all.
  //
  // One head bounds every SIPA's scan this run, and is what each persists as scanned-through — so
  // `cacheTime: 0`, since viem's default caches it for a polling interval. A lagging head both hides
  // the newest sweeps and gets persisted as the cursor, and the reorg overlap is the only thing that
  // would ever walk back over them.
  const [implementation, read, head] = await Promise.all([
    readDepositSIPAImplementation(deps.publicClient, tuple.sipaFactory as Address),
    deps.discover ? readRowEvents(deps) : Promise.resolve([]),
    deps.publicClient.getBlockNumber({ cacheTime: 0 }),
  ])
  live()
  const depositImplementation = EthAddress.fromString(implementation)
  // A direct deposit's announcement names no SIPA: it only gives its record, before any derivation.
  const events = await recordDirectAnnouncements(deps, read)

  const seen = new Set<string>()
  const kinds = await Promise.all(events.map((event) => eventKind(event, deps.recipient)))
  const eventKey = (i: number) => pinKey(events[i]!.sharedSecretSalt.toString(), kinds[i]!)
  const recipientKey = recipient.toLowerCase()

  // A self-initiated SIPA's record was written at derivation, before its event existed. Index those
  // records by salt and intent kind so an event and its record never disagree on the address. A
  // registration restarted at another fee reuses its salt at a new address, so one key can pin
  // several. Only the recipient's own records: a salt carries no recipient and nonces restart per
  // account, so another account's record under the same salt is not this one's.
  const localByKey = new Map<string, Address[]>()
  for (const r of deps.store.list()) {
    if (!r.messageSecret || r.recipientL2Address?.toLowerCase() !== recipientKey) continue
    for (const kind of recordKinds(r)) {
      const key = pinKey(r.messageSecret, kind)
      localByKey.set(key, [...(localByKey.get(key) ?? []), r.sipaAddress])
    }
  }

  const now = Date.now()

  // Priced off the table row a sweep settles on for the address's intent, one read per intent and row
  // per run — and none at all if no SIPA reaches the probe. A failed read is dropped from the map, so
  // one transient RPC error leaves only its own event unpriced.
  const fees = new Map<string, Promise<bigint>>()
  const feeFor = (intent: SipaIntent, row: SipaRow, record?: SipaDeposit | null) => {
    const table = (record && sipaRecordRoute(record)?.forwardingTable) ?? tuple.forwardingTable
    const key = `${intent}:${row.portal.toLowerCase()}:${table?.toLowerCase()}`
    const cached = fees.get(key)
    if (cached) return cached
    const pending = readDepositFee(
      deps.publicClient,
      deploymentSipaRoute({ ...tuple, forwardingTable: table }, intent, row.token.address),
    )
    fees.set(key, pending)
    pending.catch(() => {
      if (fees.get(key) === pending) fees.delete(key)
    })
    return pending
  }
  let registrationRead: Promise<EthAddress> | undefined
  const registrationImplementation = () =>
    (registrationRead ??= readRegistrationSIPAImplementation(
      deps.publicClient,
      tuple.sipaFactory as Address,
    ).then((address) => EthAddress.fromString(address)))
  // The sweep window's ceiling, a per-portal immutable: one lazy read per row per run.
  const caps = new Map<string, Promise<bigint>>()
  const txAmountCap = (row: SipaRow) => {
    const key = row.portal.toLowerCase()
    if (!caps.has(key)) caps.set(key, deps.txAmountCap(row))
    return caps.get(key)!
  }
  const fundingTokens = sipaRowFundingTokens(deps.rows)
  // A look-back taken because the history start failed to read is partial, so it marks nothing read.
  let historyFailed = false
  let startRead: Promise<bigint | undefined> | undefined
  const historyStart = () =>
    (startRead ??= (deps.historyStartBlock?.(head) ?? Promise.resolve(undefined)).catch((err) => {
      historyFailed = true
      logger.warn("[sipaScan] history start read failed, using the default look-back:", err)
      return undefined
    }))
  // Cleared by any step that leaves work to a later pass.
  let complete = true
  // A pass that did not save, or whose history start failed, is counted here.
  const finish = () => {
    result.complete = complete && !historyFailed && result.failed === 0
    return result
  }
  // An add-passkey SIPA delegates to the implementation the factory blessed when it was
  // prepared, and a later bless keeps the earlier one blessed, so every blessed one is a candidate.
  // Read once per run, however it answered, only when an event needs it. The sdk reads the factory's
  // whole history where the RPC allows and this pass's window where it does not.
  let blessedRead: Promise<EthAddress[]> | undefined
  const addPasskeyImplementations = () =>
    (blessedRead ??= (async () =>
      readBlessedImplementations(
        deps.publicClient,
        tuple.sipaFactory as Address,
        SipaIntent.AddPasskey,
        (await historyStart()) ?? lookbackStart(head),
      ))().then((addresses) => addresses.map((address) => EthAddress.fromString(address))))
  const factories = [...new Set(sipaGenerations(tuple).map((g) => g.sipaFactory.toLowerCase()))]
  const vouchedClone = async (clone: Address) => {
    for (const factory of factories) {
      const intent = sipaRecordIntentOf(
        await readSipaIntent(deps.publicClient, factory as Address, clone),
      )
      if (intent !== null) return { intent, sipaFactory: factory as Address }
    }
    return null
  }
  const cloneImplementation = async (clone: Address) => {
    const implementation = await readSipaCloneImplementation(
      deps.publicClient,
      tuple.sipaFactory as Address,
      clone,
    )
    return /^0x0+$/i.test(implementation) ? undefined : EthAddress.fromString(implementation)
  }
  const recordWrites: (() => void)[] = []
  let l2HeadRead: Promise<number> | undefined
  const run: SyncRunContext = {
    retryFrom: new Map(),
    head,
    now,
    feeFor,
    registrationImplementation,
    addPasskeyImplementations,
    vouchedClone,
    cloneImplementation,
    txAmountCap,
    fundingTokens,
    record: (write) => void recordWrites.push(write),
    pending: [],
    incomplete: () => {
      complete = false
    },
    l2Head: () => (l2HeadRead ??= deps.node.getBlockNumber().then(Number)),
  }

  result.replaying = events.some((_, i) => !localByKey.has(eventKey(i)))
  const eventPins = new Map<string, number>()
  events.forEach((_, i) => {
    const key = eventKey(i)
    if (!eventPins.has(key)) eventPins.set(key, localByKey.get(key)?.length ?? 1)
  })
  // Records are the authoritative list of self-initiated SIPAs, so one whose event is absent
  // (discovery raced the broadcast, PXE reset) still syncs, settled or not: a settled address can
  // be paid again.
  const eventless = deps.store.list().filter(
    (r) =>
      !!r.messageSecret &&
      r.recipientL2Address?.toLowerCase() === recipientKey &&
      // A direct deposit's commitment is public: another sender can deposit under it first, so
      // its record is read until the rail has claimed the batch's whole amount.
      !(r.direct && directDepositSettled(r)) &&
      !recordSeen({ ...r, messageSecret: r.messageSecret }, new Set(eventPins.keys())),
  )
  const attempt = async <T>(label: string, step: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await step()
    } catch (err) {
      result.failed += 1
      logger.warn(`[sipaScan] ${label} failed (will retry next pass):`, err)
      return undefined
    }
  }

  {
    // Every event and record names the addresses it needs read; one observation reads them all.
    const planned: PlannedEvent[] = []
    // Records whose plan failed: they keep the window this pass would have read.
    const unplanned: Address[] = []
    for (const [i, event] of events.entries()) {
      const key = eventKey(i)
      if (seen.has(key)) continue
      seen.add(key)
      for (const pin of localByKey.get(key) ?? [undefined]) {
        const plan = await attempt("event", () =>
          planEvent(deps, event, depositImplementation, run, pin),
        )
        if (plan) planned.push(plan)
        else if (pin) unplanned.push(pin)
      }
    }
    for (const r of eventless) {
      const plan = await attempt("record", () => {
        const pseudo: SipaEvent = {
          sharedSecretSalt: Fr.fromString(r.messageSecret!),
          resweepable: false,
          intentHash: NO_EVENT_INTENT,
        }
        return planEvent(deps, pseudo, depositImplementation, run, r.sipaAddress)
      })
      if (plan) planned.push(plan)
      else unplanned.push(r.sipaAddress)
    }

    // Every row's portal is observed in one pass, so the pass is read through the earliest of their
    // cursors. A portal with none, such as a row the table added, has unread history on every SIPA,
    // so the pass backfills them all, and the portal gets a cursor only once that backfill is whole.
    // An earlier SIPA set the cursors were not read with adds addresses with unread history the
    // same way.
    const portals = [...new Set(deps.rows.map((row) => row.portal.toLowerCase()))] as Address[]
    const [cursors, readSets] = await Promise.all([
      Promise.all(
        portals.map(async (portal) => {
          const saved = await deps.db.get(sipaCursorKey(portal, recipient))
          return saved === undefined ? undefined : BigInt(saved)
        }),
      ),
      deps.db.get(sipaSetsKey(recipient)),
    ])
    // Only events derive earlier-set addresses, so only a discovery pass backfills a new set.
    const sets = priorSetsKey(tuple)
    const newSets = deps.discover && (readSets ?? "") !== sets
    const cursor =
      cursors.some((c) => c === undefined) || newSets
        ? undefined
        : cursors.reduce((min, c) => (c! < min! ? c : min))
    // Reading L1 alone, with every SIPA read through a cursor the head has not passed: nothing is new.
    if (
      !deps.discover &&
      cursor !== undefined &&
      head <= cursor &&
      unplanned.length === 0 &&
      planned.every((p) => p.owner?.observedFrom && !p.owner.rescanFrom) &&
      !deps.resolverCandidates?.length
    )
      return finish()
    const owners = [...planned.map((p) => p.owner), ...unplanned.map((a) => deps.store.get(a))]
    const backfillFrom = owners.some((owner) => windowStart(owner, cursor) === undefined)
      ? (await historyStart()) ?? lookbackStart(head)
      : 0n
    for (const address of unplanned) {
      const record = deps.store.get(address)
      // A pass that backfills every SIPA leaves a failed one the whole history to re-read.
      const start = windowStart(record, cursor) ?? (record?.observedFrom ? backfillFrom : undefined)
      if (start !== undefined) run.record(markForRescan(deps, address, start))
    }
    const windowOf = (plan: PlannedEvent) => {
      const start = windowStart(plan.owner, cursor)
      return {
        fromBlock: start ?? backfillFrom,
        backfilled: start === undefined,
        complete: start !== undefined || !historyFailed,
      }
    }
    // A slot shown and never published has no event; only its own derivation finds it.
    const self = selfDeployment(tuple, implementation, deps.recoveryAccount, fundingTokens)
    const salts = new Set(events.map((event) => event.sharedSecretSalt.toString()))
    const own =
      deps.discover && self && deps.selfCandidates
        ? await deps.selfCandidates(self, deps.store.list(), salts)
        : []
    const candidates = [...(deps.resolverCandidates ?? []), ...own]
    const { observed, strays, held, chainTime } = await observeSipas(deps.publicClient, {
      portals,
      holdings: candidates.map((c) => c.sipaAddress),
      tokens: [...new Set(fundingTokens.map((t) => t.address.toLowerCase()))] as Address[],
      head,
      subjects: planned.flatMap((plan) =>
        plan.addresses.map((address) => ({
          address,
          // The stored hash is what the address was derived with.
          commitment: (plan.owner?.recipientHash || plan.recipientCommitment.toString()) as Hex,
          fromBlock: windowOf(plan).fromBlock,
          // Read for a claimed address too: a new payment there is dated by its transfer.
          inflows:
            (!plan.owner?.fundingFromAddress || (!!plan.owner && claimedBefore(plan.owner))) &&
            !plan.owner?.direct,
          ...(plan.owner?.direct ? { direct: true } : {}),
        })),
      ),
    })

    live()
    if (chainTime !== undefined) result.chainTime = Number(chainTime) * 1000
    await adoptStrays(deps, run, planned, strays)
    // A funded window address is recorded now; the next pass reads its history. Nobody else
    // publishes it, so it owes its broadcast, unless it holds only ETH, which no sweep moves.
    for (const candidate of candidates) {
      const balances = held.get(candidate.sipaAddress.toLowerCase())
      if (!balances || deps.store.get(candidate.sipaAddress)) continue
      const fields = resolverPaymentFields(candidate, balances, {
        recipient: deps.recipient,
        l1ChainId: deps.l1ChainId,
        networkId: deps.networkId,
        now,
      })
      if (!fields) continue
      const address = candidate.sipaAddress
      const { day, nonce } = candidate
      const slot = own.includes(candidate) ? { slot: { day, nonce } } : {}
      deps.store.apply(address, { type: "discovered", fields: { ...fields, ...slot } })
      if (deps.republishes !== false && fields.tokenAddress !== NATIVE_ETH.address)
        deps.store.apply(address, {
          type: "broadcastOwed",
          address,
          owed: { kind: "deposit", source: { type: "slot" }, fundedAt: now },
          at: now,
        })
      result.resolverFunded += 1
    }

    const due: DueScan[] = []
    for (const plan of planned) {
      const window = windowOf(plan)
      // Resolved without the blessed list: the window is read again once the list reads.
      if (!plan.candidatesKnown) rereadFrom(run, plan.addresses[0]!, window.fromBlock)
      if (!plan.addresses.every((address) => observed.has(address.toLowerCase()))) {
        // Its window failed: it keeps its place and re-reads that window next pass.
        result.failed += 1
        run.record(markForRescan(deps, plan.addresses[0]!, window.fromBlock))
        continue
      }
      const scans = await attempt("event", () => finishEvent(plan, observed, window, result, run))
      if (scans) due.push(...scans)
      else run.record(markForRescan(deps, plan.addresses[0]!, window.fromBlock))
    }
    await prefetchSweepReads(deps, due)
    for (const scan of due) {
      live()
      try {
        await scanOne(scan)
      } catch (err) {
        result.failed += 1
        run.record(markForRescan(deps, scan.sipaAddress, scan.fromBlock))
        logger.warn(`[sipaScan] ${scan.sipaAddress} failed (will retry next pass):`, err)
      }
    }
    await markSpent(deps, run.pending)
    live()
    for (const write of recordWrites) write()
    // Every SIPA read this pass is covered through `head`, or holds its own place to re-read from:
    // the cursor commits with the records that say so.
    const advanced = portals.filter((_, i) => cursors[i] !== undefined || !historyFailed)
    try {
      await deps.db.write(async (w) => {
        await deps.saved.applyAll(deps.store.events, w)
        live()
        for (const portal of advanced) w.put(sipaCursorKey(portal, recipient), head.toString())
        if (newSets && !historyFailed) w.put(sipaSetsKey(recipient), sets)
      })
      result.found = foundCount(startRecords, deps.store.list())
      result.republished = deps.store.events.filter(
        ([, e]) => e.type === "broadcastRepublish",
      ).length
    } catch (err) {
      live()
      result.failed += 1
      logger.warn("[sipaScan] the pass did not save (reconciled next pass):", err)
    }
  }

  return finish()
}

/**
 * Writes the deposit record of each event that announces a direct deposit (a migration executor's
 * deposit straight into the portal, with no SIPA), unless it exists, and returns the other events
 * and whether a write did not land. The record has no read window yet, so the pass reads its
 * commitment from the deployment's start.
 */
async function recordDirectAnnouncements(
  deps: PassDeps,
  events: readonly RowEvent[],
): Promise<SipaEvent[]> {
  const rest: SipaEvent[] = []
  for (const { event, l2Token } of events) {
    const commitment = await directAnnouncementOf(event, deps.recipient)
    if (!commitment) {
      rest.push(event)
      continue
    }
    const key = directDepositKey(commitment)
    // The destination asset's token announces the deposit, which lands on that token's row.
    const row = sipaRowByL2Token(deps.rows, l2Token)!
    deps.store.apply(key, {
      type: "discovered",
      fields: {
        sipaAddress: key,
        phase: "broadcast",
        replayed: true,
        recipientL2Address: deps.recipient.toString(),
        messageSecret: event.sharedSecretSalt.toString(),
        recipientHash: commitment,
        recoveryAddress: "",
        l1ChainId: deps.l1ChainId,
        networkId: deps.networkId,
        amount: "0",
        tokenSymbol: row.token.symbol,
        tokenAddress: row.token.address,
        tokenDecimals: row.token.decimals,
        startTime: Date.now(),
        direct: { recipientCommitment: commitment, portal: row.portal },
        fee: "0",
      },
    })
  }
  return rest
}

/** The commitment a direct deposit's announcement names, or undefined for any other event. */
async function directAnnouncementOf(
  event: SipaEvent,
  recipient: AztecAddress,
): Promise<Hex | undefined> {
  const commitment = (
    await computeStealthRecipientHash(event.sharedSecretSalt, recipient)
  ).toString() as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(commitment) || !/^0x[0-9a-fA-F]+$/.test(event.intentHash))
    return undefined
  return BigInt(event.intentHash) === BigInt(directAnnouncementIntentHash(commitment))
    ? (commitment.toLowerCase() as Hex)
    : undefined
}

/** The earlier SIPA sets of `tuple` as one value. */
function priorSetsKey(tuple: OxideEnvTuple): string {
  return (tuple.priorSipaGenerations ?? [])
    .map((g) =>
      [
        g.sipaFactory,
        g.forwardingTable,
        g.depositSIPAImplementation,
        g.registrationSIPAImplementation,
      ].join(":"),
    )
    .join(",")
    .toLowerCase()
}

/**
 * Where a SIPA's read starts: the deployment's cursor once its history was read, less the reorg
 * overlap, or the start of a window a failed pass left it, if earlier. Undefined when its history is
 * still unread, as for every record written before the cursor existed.
 */
function windowStart(owner: SipaDeposit | null, cursor: bigint | undefined): bigint | undefined {
  if (cursor === undefined || !owner?.observedFrom) return undefined
  const steady = bigMax(cursor - SCAN_REORG_OVERLAP_BLOCKS, 0n)
  const rescan = owner.rescanFrom ? BigInt(owner.rescanFrom) : undefined
  return rescan !== undefined && rescan < steady ? rescan : steady
}

/** How many of `after` hold new funds, or a sweep the same record in `before` did not. */
function foundCount(before: readonly SipaDeposit[], after: readonly SipaDeposit[]): number {
  const was = new Map(before.map((r) => [sipaDepositId(r.sipaAddress), r]))
  return after.filter((r) => {
    const prior = was.get(sipaDepositId(r.sipaAddress))
    const swept = new Set(prior?.pendingSweeps?.map((s) => s.inboxIndex))
    return (
      (r.phase === "sweeping" && prior?.phase !== "sweeping") ||
      !!r.pendingSweeps?.some((s) => !swept.has(s.inboxIndex))
    )
  }).length
}

/**
 * The pass's own copy of the recipient's records: each event applies here at once and is kept, and
 * the pass commits the events together at its end.
 */
interface WorkingSet {
  get(address: string): SipaDeposit | null
  list(): SipaDeposit[]
  apply(address: string, event: SipaDepositEvent): void
  /** The events that changed a record, in order. */
  readonly events: (readonly [string, SipaDepositEvent])[]
}

function workingSet(records: readonly SipaDeposit[]): WorkingSet {
  const held = new Map(records.map((r) => [sipaDepositId(r.sipaAddress), r]))
  const events: (readonly [string, SipaDepositEvent])[] = []
  return {
    events,
    get: (address) => held.get(sipaDepositId(address)) ?? null,
    list: () => [...held.values()],
    apply(address, event) {
      const id = sipaDepositId(address)
      const before = held.get(id)
      const next = sipaDepositTransition(before, event, Date.now())
      if (next === undefined || JSON.stringify(next) === JSON.stringify(before)) return
      if (next === null) held.delete(id)
      else held.set(id, next)
      events.push([address, event])
    },
  }
}

/** The pass's deps: its store is the working set. */
type PassDeps = Omit<SipaScanDeps, "store"> & {
  store: WorkingSet
  /** The saved records: another account's, and where the pass commits. */
  saved: SipaScanDeps["store"]
}

/** The record at `address`, this recipient's or another account's. */
async function recordAnywhere(deps: PassDeps, address: string): Promise<SipaDeposit | null> {
  return deps.store.get(address) ?? (await deps.saved.get(address)) ?? null
}

/** What a pass read of `address` on chain. */
function observe(
  deps: PassDeps,
  address: string,
  fields: SipaObservation,
  ledger?: SIPASweep,
): void {
  deps.store.apply(address, { type: "observed", fields, ...(ledger ? { ledger } : {}) })
}

function lookbackStart(head: bigint): bigint {
  return head > SIPA_DEFAULT_LOOKBACK_BLOCKS ? head - SIPA_DEFAULT_LOOKBACK_BLOCKS : 0n
}

/**
 * Tracks the SIPA behind a deposit to one of this wallet's commitments that no tracked SIPA sent,
 * such as a registration address this device never derived: the deposit's own `Sweep` log names it
 * and the factory names its intent, so a clone of an implementation this pass could not list is
 * still filed as what it is. The next pass reads its history and claims it like any other.
 */
async function adoptStrays(
  deps: PassDeps,
  run: SyncRunContext,
  planned: readonly PlannedEvent[],
  strays: readonly PortalDeposit[],
): Promise<void> {
  if (strays.length === 0) return
  const byCommitment = new Map(
    planned.map((plan) => [
      (plan.owner?.recipientHash || plan.recipientCommitment.toString()).toLowerCase(),
      plan,
    ]),
  )
  await Promise.all(
    strays.map(async (deposit) => {
      const plan = byCommitment.get(deposit.recipientCommitment.toLowerCase())
      if (!plan) return
      try {
        // Any contract can emit the log: the clone is the first emitter the factory vouches for.
        for (const sipa of await readSweepEmitters(
          deps.publicClient,
          deposit.txHash,
          deposit.index,
        )) {
          if (await recordAnywhere(deps, sipa)) return
          const vouched = await run.vouchedClone(sipa)
          if (!vouched) continue
          const { intent } = vouched
          const origin =
            (await cloneOrigin(deps, plan, sipa, vouched.sipaFactory)) ?? plan.originOf(sipa)
          logger.info(
            `[sipaScan] tracking ${sipa}: it swept deposit ${deposit.index} to this wallet`,
          )
          deps.store.apply(sipa, {
            type: "discovered",
            fields: {
              sipaAddress: sipa,
              phase: "broadcast",
              replayed: true,
              recipientL2Address: deps.recipient.toString(),
              messageSecret: plan.sharedSecretSalt.toString(),
              recipientHash: deposit.recipientCommitment,
              recoveryAddress: plan.accountProtocol ? "" : plan.recoveryAddress.toString(),
              l1ChainId: deps.l1ChainId,
              networkId: deps.networkId,
              amount: "0",
              tokenSymbol: sipaDefaultRow(deps.tuple, deps.rows, intent).token.symbol,
              startTime: Date.now(),
              tokenAddress: sipaDefaultRow(deps.tuple, deps.rows, intent).token.address,
              ...(origin ? { origin } : {}),
              ...(intent ? { intent } : {}),
            },
          })
          run.incomplete()
          return
        }
      } catch (err) {
        // The commitment's SIPA re-reads from the deposit, so a later pass meets the stray again.
        run.incomplete()
        rereadFrom(run, plan.addresses[0]!, deposit.blockNumber)
        logger.warn(`[sipaScan] could not track the SIPA behind deposit ${deposit.index}:`, err)
      }
    }),
  )
}

/**
 * A swept clone's origin as the chain holds it, so a pass without events files it too. Undefined
 * unless its recovery commitment is the plan's: only then is it this wallet's to recover.
 */
async function cloneOrigin(
  deps: PassDeps,
  plan: PlannedEvent,
  clone: Address,
  sipaFactory: Address,
): Promise<SipaDeposit["origin"]> {
  if (!plan.accountProtocol) return undefined
  const [implementation, args] = await Promise.all([
    readSipaCloneImplementation(deps.publicClient, sipaFactory, clone),
    readSipaCloneArgs(deps.publicClient, clone),
  ])
  if (args.recoveryCommitment.toLowerCase() !== plan.recoveryCommitment!.toString().toLowerCase())
    return undefined
  return plan.originFor(
    EthAddress.fromString(implementation),
    { sipaFactory, forwardingTable: args.forwardingTable },
    args,
  )
}

/** The next pass reads `owner` from `block` or earlier, stamped when its scan is covered. */
function rereadFrom(run: SyncRunContext, owner: Address, block: bigint) {
  const key = owner.toLowerCase()
  const known = run.retryFrom.get(key)
  if (known === undefined || block < known) run.retryFrom.set(key, block)
}

/** A failed SIPA re-reads from the window it missed, however far the cursor moves meanwhile. */
function markForRescan(deps: PassDeps, sipaAddress: Address, fromBlock: bigint) {
  return () => {
    const stored = deps.store.get(sipaAddress)
    if (!stored?.observedFrom) return
    if (stored.rescanFrom && BigInt(stored.rescanFrom) <= fromBlock) return
    observe(deps, sipaAddress, { rescanFrom: fromBlock.toString() })
  }
}

/** Stamp the funder + funding tx off the first observed `Transfer(to = sipa)` and fire the contact hook. */
async function attributeFunding(
  deps: PassDeps,
  sipaAddress: Address,
  run: SyncRunContext,
  inflows: readonly TokenTransfer[],
): Promise<bigint | undefined> {
  const found = firstFunding(
    run.fundingTokens.map((token) =>
      inflows
        .filter((flow) => flow.token.toLowerCase() === token.address.toLowerCase())
        .map((flow) => ({
          from: flow.from,
          amount: flow.value,
          blockNumber: flow.blockNumber,
          txHash: flow.txHash,
        })),
    ),
    run.fundingTokens,
  )
  if (!found) return undefined
  const { transfer: first, token: fundedWith } = found

  const current = deps.store.get(sipaAddress)
  const patch: Partial<SipaDeposit> = {
    fundingTxHash: first.txHash,
    fundingFromAddress: first.from,
    fundingTokenSymbol: fundedWith.symbol,
  }
  // Attribution can arrive after a sweep or claim; keep the credited token in that case.
  if (current?.netAmount == null) {
    patch.tokenAddress = fundedWith.address
    patch.tokenSymbol = fundedWith.symbol
    patch.tokenDecimals = fundedWith.decimals
    if (current) {
      const row = sipaRowByFunding(deps.rows, fundedWith.address)
      patch.fee = feeOnRow(deps, current, current.intent, row, undefined)
    }
  }
  // Backfill the display identity so third-party deposits thread under a
  // contact; a connected-session identity is never overwritten.
  if (!current?.walletAddress) patch.walletAddress = first.from
  observe(deps, sipaAddress, patch)

  if (deps.onFundingWalletDetected) {
    const sessionMatch = current?.walletAddress?.toLowerCase() === first.from.toLowerCase()
    await deps.onFundingWalletDetected({
      address: first.from,
      walletName: sessionMatch ? current?.walletName : undefined,
      lastUsedAt: Date.now(),
    })
  }
  return first.blockNumber
}

/** The intentHash of a record's synthesized event: no event was discovered, so it carries no intent. */
const NO_EVENT_INTENT = "0x0"

/**
 * Whether an event announces a deposit, and the hash its address commits to. A deposit commits to
 * the recipient, so its hash re-derives here. Any other hash is a registration or an add-passkey,
 * whose intent data only the event's sender holds.
 */
function eventIntent(
  sipaEvent: SipaEvent,
  recipientCommitment: Fr,
): { deposit: boolean; intentHash: Buffer } {
  const deposit = keccak256(recipientCommitment.toBuffer())
  const carried = Buffer.from(sipaEvent.intentHash.slice(2).padStart(64, "0"), "hex")
  return carried.equals(deposit)
    ? { deposit: true, intentHash: deposit }
    : { deposit: false, intentHash: carried }
}

/** Plain deposits and the other intents pin separately, even under one salt. */
type IntentKind = "deposit" | "other"

const pinKey = (salt: string, kind: IntentKind) => `${salt.toLowerCase()}:${kind}`

/**
 * The kinds of event a record can stand for. One with no intent whose origin was derived is a
 * deposit; one with neither predates both fields and takes its intent from whichever event matches.
 */
const recordKinds = (record: SipaDeposit): IntentKind[] =>
  record.intent ? ["other"] : record.origin ? ["deposit"] : ["deposit", "other"]

const recordSeen = (record: SipaDeposit & { messageSecret: string }, keys: Set<string>) =>
  recordKinds(record).some((kind) => keys.has(pinKey(record.messageSecret, kind)))

async function eventKind(sipaEvent: SipaEvent, recipient: AztecAddress): Promise<IntentKind> {
  const commitment = await computeStealthRecipientHash(sipaEvent.sharedSecretSalt, recipient)
  return eventIntent(sipaEvent, commitment).deposit ? "deposit" : "other"
}

/** A SIPA ready for its scan: what discovery found, and what the pass observed of it. */
type DueScan = Awaited<ReturnType<typeof finishEvent>>[number]

/** Values shared by every event in one run: the scan's upper bound, its clock, its fee floors. */
interface SyncRunContext {
  head: bigint
  now: number
  /** A sweep's fee on `row`, from the table `record`'s origin names, else the pinned one. */
  feeFor: (intent: SipaIntent, row: SipaRow, record?: SipaDeposit | null) => Promise<bigint>
  registrationImplementation: () => Promise<EthAddress>
  /** Every add-passkey implementation the factory has blessed, the current one first. */
  addPasskeyImplementations: () => Promise<EthAddress[]>
  /** The first SIPA set's factory that cloned `clone`, and the intent it cloned it for; else null. */
  vouchedClone: (
    clone: Address,
  ) => Promise<{ intent: SipaDeposit["intent"]; sipaFactory: Address } | null>
  /** The implementation a deployed clone delegates to, from its code. Undefined for an address without one. */
  cloneImplementation: (clone: Address) => Promise<EthAddress | undefined>
  /** A row portal's `TX_AMOUNT_CAP()`: the most one sweep may credit. */
  txAmountCap: (row: SipaRow) => Promise<bigint>
  /** Every token a SIPA of `deps.rows` may be funded with; non-empty. */
  fundingTokens: SipaFundingToken[]
  /**
   * Queues a sweep's event. The queue runs in order after the pass's one balance read, so a
   * claim reads `claimed` only once the balance holds it and never overwrites a later sweep's state.
   */
  record: (write: () => void) => void
  /** Every sweep the pass leaves to the claim run, with its row's L2 token. */
  pending: { sweep: SIPAPendingSweep; l2Token: string }[]
  /** A step left work to a later pass: the result is not `complete`. */
  incomplete: () => void
  /** Blocks SIPAs must re-read from on a later pass, by lowercased address: a stray they lost. */
  retryFrom: Map<string, bigint>
  /** The L2 head, read once per pass when a broadcast is owed again. */
  l2Head: () => Promise<number>
}

/** The pass's L1 client: a block is read once however many steps need it. A failed read is dropped. */
export function passClient(client: PublicClient): PublicClient {
  const blocks = new Map<bigint, ReturnType<PublicClient["getBlock"]>>()
  return {
    ...client,
    getBlock: ((args) => {
      if (args?.blockNumber === undefined || args.includeTransactions) return client.getBlock(args)
      const key = args.blockNumber
      const cached = blocks.get(key)
      if (cached) return cached
      const pending = client.getBlock(args)
      blocks.set(key, pending)
      pending.catch(() => {
        if (blocks.get(key) === pending) blocks.delete(key)
      })
      return pending
    }) as PublicClient["getBlock"],
  }
}

/** A `SIPA` event and the row L2 token that emitted it. */
interface RowEvent {
  event: SipaEvent
  l2Token: string
}

/**
 * The recipient's `SIPA` events on every row's L2 token, each SIPA once. The wallet's own broadcast
 * notifies the pinned bridge's token and the resolver's each portal's, so a fresh device finds a SIPA
 * either way.
 */
async function readRowEvents(deps: PassDeps): Promise<RowEvent[]> {
  const l2Tokens = [...new Set(deps.rows.map((row) => row.l2Token.toLowerCase()))]
  const perToken = await Promise.all(
    l2Tokens.map((l2Token) =>
      fetchSipaEvents(deps.wallet, AztecAddress.fromStringUnsafe(l2Token), deps.recipient),
    ),
  )
  const seen = new Set<string>()
  const tagged = perToken.flatMap((events, i) =>
    events.map((event) => ({ event, l2Token: l2Tokens[i]! })),
  )
  return tagged.filter(({ event }) => {
    const key = `${event.sharedSecretSalt
      .toString()
      .toLowerCase()}:${event.intentHash.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Starts every read a due SIPA's claim tail makes before the first claim: its funding and sweep
 * blocks and each sweep's message readiness. They batch into a few round trips, and the tail then
 * finds them in the pass's caches. A failed read is left to the tail.
 */
async function prefetchSweepReads(deps: PassDeps, due: readonly DueScan[]): Promise<void> {
  await Promise.all(
    due.flatMap((scan) => {
      const claimed = new Set(scan.record?.claimedInboxIndexes ?? [])
      const firstFunding = scan.observed.inflows?.[0]?.blockNumber
      return [
        ...(firstFunding === undefined
          ? []
          : [bestEffort("unknown", readBlockTimeMs(deps.publicClient, firstFunding))]),
        ...sweepsOf(scan)
          .filter((s) => !claimed.has(s.index.toString()))
          .map((sweep) =>
            bestEffort("unknown", readBlockTimeMs(deps.publicClient, sweep.blockNumber)),
          ),
      ]
    }),
  )
}

/**
 * A sweep to settle, with what an earlier pass saw it take when its window is gone. A sweep an earlier
 * pass saved before sweeps named their portal has none.
 */
type PassSweep = Omit<ObservedSweep, "portal" | "blockHash"> & {
  portal?: Address
  blockHash?: Hex
  funding?: { token: Address; gross: bigint }
}

/**
 * What the pass observed swept from a SIPA, plus the sweeps an earlier pass left unclaimed. The
 * observation answers for its window: a saved sweep inside it that it no longer shows was reorged
 * away, and one it shows again takes its observed claim inputs.
 */
function sweepsOf(scan: DueScan): PassSweep[] {
  const sweeps: PassSweep[] = [...scan.observed.sweeps]
  for (const pending of scan.record?.pendingSweeps ?? []) {
    if (sweeps.some((s) => s.index.toString() === pending.inboxIndex)) continue
    if (BigInt(pending.blockNumber) >= scan.fromBlock) continue
    sweeps.push({
      index: BigInt(pending.inboxIndex),
      amount: BigInt(pending.amount),
      messageKey: pending.messageKey,
      blockNumber: BigInt(pending.blockNumber),
      txHash: pending.sweepTxHash,
      ...(pending.portal ? { portal: pending.portal } : {}),
      ...(pending.grossAmount && pending.fundingToken
        ? { funding: { token: pending.fundingToken, gross: BigInt(pending.grossAmount) } }
        : {}),
    })
  }
  return sweeps.sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  )
}

/**
 * What one event, or one record with no event, needs observed. `local` is the recorded address of
 * a self-initiated SIPA; it overrides the event's derivation. Reads nothing from L1.
 */
async function planEvent(
  deps: PassDeps,
  sipaEvent: SipaEvent,
  depositImplementation: EthAddress,
  run: SyncRunContext,
  local?: Address,
) {
  const { tuple } = deps
  const sharedSecretSalt = sipaEvent.sharedSecretSalt
  const recipientCommitment = await computeStealthRecipientHash(sharedSecretSalt, deps.recipient)
  const recoveryAddress = deriveRecoveryAddress(deps.stealthPublicKey, sharedSecretSalt)
  const fromEvent =
    sipaEvent.intentHash === NO_EVENT_INTENT ? null : eventIntent(sipaEvent, recipientCommitment)
  const accountProtocol = tuple.sipaRecoveryProtocol === "account"
  if (accountProtocol && !tuple.accountFactory)
    throw new WalletError("config.invalid", "the manifest lacks the account factory")
  if (accountProtocol && !tuple.forwardingTable)
    throw new WalletError("config.invalid", "the manifest lacks the forwarding table")
  const recoveryCommitment = accountProtocol
    ? deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(deps.recoveryAccount))
    : undefined
  const [current, ...prior] = sipaGenerations(tuple)
  const predict = (implementation: EthAddress, generation: SipaGeneration = current!) => {
    if (!fromEvent) return undefined
    const inputs = {
      sipaFactory: EthAddress.fromString(generation.sipaFactory),
      implementation,
      intentHash: fromEvent.intentHash,
      rollupVersion: BigInt(tuple.rollupVersion),
      resweepable: sipaEvent.resweepable,
    }
    if (!accountProtocol) return computeSIPAAddress({ ...inputs, recoveryAddress })
    // A set from before the table derives no account-protocol address.
    if (!generation.forwardingTable) return undefined
    return computeAccountSIPAAddress({
      ...inputs,
      recoveryCommitment: recoveryCommitment!,
      forwardingTable: EthAddress.fromString(generation.forwardingTable),
    })
  }
  const originFor = (
    implementation: EthAddress,
    generation: { sipaFactory?: string; forwardingTable?: string } = tuple,
    clone: { intentHash: Hex; resweepable: boolean } = {
      intentHash: sipaEvent.intentHash,
      resweepable: sipaEvent.resweepable,
    },
  ): SipaDeposit["origin"] => ({
    sipaFactory: generation.sipaFactory! as Address,
    implementation: implementation.toString() as Address,
    intentHash: clone.intentHash,
    rollupVersion: tuple.rollupVersion,
    resweepable: clone.resweepable,
    ...(accountProtocol
      ? {
          protocol: "account" as const,
          accountFactory: tuple.accountFactory! as Address,
          forwardingTable: generation.forwardingTable! as Address,
          recoveryAccount: deps.recoveryAccount,
          recoveryCommitment: recoveryCommitment!.toString() as Hex,
        }
      : {
          protocol: "legacy-eoa" as const,
          recoveryAddress: recoveryAddress.toString() as Address,
        }),
  })
  /** The origin of `address` when the event derives it under any SIPA set's implementation. */
  const originOf = (address: Address): SipaDeposit["origin"] => {
    for (const generation of sipaGenerations(tuple))
      for (const listed of [
        generation.depositSIPAImplementation,
        generation.registrationSIPAImplementation,
      ]) {
        if (!listed) continue
        const implementation = EthAddress.fromString(listed)
        const derived = predict(implementation, generation)?.toString()
        if (derived?.toLowerCase() === address.toLowerCase())
          return originFor(implementation, generation)
      }
    return undefined
  }
  // The intent comes from the record when it holds one, else the event. Only the event's sender
  // holds a non-deposit intent's data, so the chain decides: an add-passkey SIPA is swept when
  // the relayer runs it, and a clone holding a registration's intent hash cannot be. Until that
  // sweep, the event reads as a registration. A record that may be a misfiled add-passkey keeps
  // watching for it until it is swept.
  const pinned = local ? deps.store.get(local) : null
  const recheck = maybeMisfiled(pinned)
  const resolving = !!fromEvent && !fromEvent.deposit && (!pinned?.intent || recheck)
  const guess = resolving ? "registration" : pinned?.intent
  const candidate = (implementation: EthAddress): AddPasskeyCandidate | undefined => {
    const address = predict(implementation)?.toString() as Address | undefined
    return address && { implementation, address }
  }
  // A recorded add-passkey SIPA was prepared on the implementation its origin names, else on
  // the one its deployed clone delegates to, else on the blessed one that derives it.
  const addPasskeyImplementation = async () => {
    const recorded = pinned?.origin?.implementation
    if (recorded) return EthAddress.fromString(recorded)
    const deployed = local ? await run.cloneImplementation(local) : undefined
    if (deployed) return deployed
    const blessed = await run.addPasskeyImplementations()
    const found = blessed.find(
      (impl) => candidate(impl)?.address.toLowerCase() === local?.toLowerCase(),
    )
    if (!found)
      throw new WalletError(
        "scan.incomplete",
        `no blessed add-passkey implementation derives ${local}`,
      )
    return found
  }
  const implementation =
    guess === "registration"
      ? await run.registrationImplementation()
      : guess === "add-passkey"
      ? await addPasskeyImplementation()
      : depositImplementation
  const predicted = predict(implementation)
  const primary = local ?? (predicted?.toString() as Address | undefined)
  if (!primary) throw new WalletError("invariant", "a SIPA event with no address")
  // An implementation that derives the registration address is no add-passkey's.
  const taken = new Set([primary.toLowerCase()])
  const addPasskeyCandidates: AddPasskeyCandidate[] = []
  // Without the blessed list the event resolves as a registration this pass; a registration is not
  // held back by a read it does not need.
  let candidatesKnown = true
  if (resolving) {
    const blessed = await run.addPasskeyImplementations().catch((err: unknown) => {
      candidatesKnown = false
      run.incomplete()
      logger.warn("[sipaScan] blessed add-passkey implementations unread this pass:", err)
      return [] as EthAddress[]
    })
    for (const impl of blessed) {
      const found = candidate(impl)
      if (!found || taken.has(found.address.toLowerCase())) continue
      taken.add(found.address.toLowerCase())
      addPasskeyCandidates.push(found)
    }
  }
  // An event the scan found but no record shows funded may be an earlier SIPA set's: its address
  // under each one is read too, until it has a record of its own.
  const generationCandidates: GenerationCandidate[] = []
  const unexplained = !pinned || (!!pinned.replayed && isUnfundedSipaDeposit(pinned))
  if (fromEvent && unexplained && guess !== "add-passkey") {
    for (const generation of prior) {
      const implementation =
        guess === "registration"
          ? generation.registrationSIPAImplementation
          : generation.depositSIPAImplementation
      if (!implementation) continue
      const address = predict(EthAddress.fromString(implementation), generation)?.toString() as
        | Address
        | undefined
      if (!address || taken.has(address.toLowerCase()) || deps.store.get(address)) continue
      taken.add(address.toLowerCase())
      generationCandidates.push({
        generation,
        implementation: EthAddress.fromString(implementation),
        address,
      })
    }
  }
  return {
    deps,
    sipaEvent,
    depositImplementation,
    local,
    sharedSecretSalt,
    recipientCommitment,
    recoveryAddress,
    fromEvent,
    accountProtocol,
    recoveryCommitment,
    predict,
    originFor,
    originOf,
    pinned,
    recheck,
    addPasskeyCandidates,
    generationCandidates,
    candidatesKnown,
    guess,
    implementation,
    predicted,
    /** The record whose history and cursor this event's reads follow. */
    owner: deps.store.get(primary),
    addresses: [
      primary,
      ...addPasskeyCandidates.map((c) => c.address),
      ...generationCandidates.map((c) => c.address),
    ],
  }
}

type PlannedEvent = Awaited<ReturnType<typeof planEvent>>

/** A blessed add-passkey implementation and the address an event's clone has on it. */
interface AddPasskeyCandidate {
  implementation: EthAddress
  address: Address
}

/** The event's address under an earlier SIPA set. */
interface GenerationCandidate extends AddPasskeyCandidate {
  generation: SipaGeneration
}

/** A clone the chain showed in use beside the event's address: a swept add-passkey, or an earlier set's. */
type SweptClone = AddPasskeyCandidate & {
  intent: SipaDeposit["intent"]
  generation?: SipaGeneration
}

/** Whether the chain shows an address funded, swept or emptied. */
function inUse(observed: ObservedSipa | undefined): boolean {
  if (!observed) return false
  if (observed.sweeps.length || observed.outflows.length || observed.inflows?.length) return true
  return [...observed.balances.values()].some((balance) => balance > 0n)
}

/** Writes what discovery learned about one event and hands each swept clone's observation to the scan. */
async function finishEvent(
  plan: PlannedEvent,
  observed: Map<string, ObservedSipa>,
  window: { fromBlock: bigint; backfilled: boolean; complete: boolean },
  result: SipaScanResult,
  run: SyncRunContext,
) {
  const { deps, depositImplementation, local, sharedSecretSalt, recipientCommitment } = plan
  const { recoveryAddress, fromEvent, accountProtocol, predict, originFor, originOf, pinned } = plan
  const { recheck, addPasskeyCandidates, guess } = plan
  let intent = pinned?.intent
  let misfiled: Address | undefined
  const swept = (address: Address) => !!observed.get(address.toLowerCase())?.sweeps.length
  const sweptAddPasskeys = addPasskeyCandidates.filter((c) => swept(c.address))
  const addPasskey = sweptAddPasskeys[0]
  // Every swept clone holds a credit of its own: the first resolves the event, the others get records
  // beside it.
  const sweptClones: SweptClone[] = sweptAddPasskeys.map((c) => ({
    ...c,
    intent: "add-passkey" as const,
  }))
  if (fromEvent && !fromEvent.deposit && (!intent || recheck)) {
    const clone = sweptClones[0]
    // A funded, misfiled record keeps its stray funds under its own intent: the swept clone gets a
    // record beside it.
    const holdsStray = !!clone && recheck && !isUnfundedSipaDeposit(pinned!)
    if (!holdsStray) {
      const resolved = clone?.intent ?? "registration"
      if (recheck && resolved !== intent) misfiled = local
      intent = resolved
    }
  }
  // Each earlier set's address the chain shows in use holds funds of its own, so it gets a record
  // beside the event's.
  const movedClones: SweptClone[] =
    intent === guess
      ? plan.generationCandidates
          .filter((c) => inUse(observed.get(c.address.toLowerCase())))
          .map((c) => ({ ...c, intent }))
      : []
  const implementation =
    intent === guess
      ? plan.implementation
      : intent === "registration"
      ? await run.registrationImplementation()
      : intent === "add-passkey"
      ? addPasskey!.implementation
      : depositImplementation
  const predicted = intent === guess ? plan.predicted : predict(implementation)
  const sipaAddress = (misfiled ? undefined : local) ?? (predicted?.toString() as Address)
  // A record adopted as a stray holds an address the event derives under some other set.
  const origin =
    predicted?.toString().toLowerCase() === sipaAddress.toLowerCase()
      ? originFor(implementation)
      : pinned?.origin
      ? undefined
      : originOf(sipaAddress)
  result.discovered += 1

  const fallback: Omit<SipaDepositFields, "sipaAddress" | "phase"> = {
    recipientL2Address: deps.recipient.toString(),
    messageSecret: sharedSecretSalt.toString(),
    recipientHash: recipientCommitment.toString(),
    recoveryAddress: accountProtocol ? "" : recoveryAddress.toString(),
    origin,
    l1ChainId: deps.l1ChainId,
    networkId: deps.networkId,
    amount: "0",
    tokenSymbol: sipaDefaultRow(deps.tuple, deps.rows, intent).token.symbol,
    startTime: Date.now(),
    tokenAddress: sipaDefaultRow(deps.tuple, deps.rows, intent).token.address,
    ...(intent ? { intent } : {}),
  }
  // Writes what the event proved about an address. A record first seen this run (a fresh device
  // replaying history) carries no real start time until its funding or sweep block is read below.
  // Self-initiated records are created pre-discovery with empty derived fields — backfill them so
  // the deposit is enumerable. Monotonic: never overwrite a non-empty value.
  const file = (address: Address, fields: typeof fallback) =>
    deps.store.apply(address, {
      type: "discovered",
      fields: { ...fields, sipaAddress: address, phase: "broadcast", replayed: true },
    })
  const existing = deps.store.get(sipaAddress)
  const discovered = !existing
  file(sipaAddress, fallback)

  if (misfiled) deps.store.apply(misfiled, { type: "misfiled" })
  // A record with the salt and this recipient is planned on its own, as this event's pin or without
  // an event: its scan is that plan's.
  const recipientKey = deps.recipient.toString().toLowerCase()
  const plannedOnItsOwn = (record: SipaDeposit | null | undefined) =>
    !!record?.messageSecret && record.recipientL2Address?.toLowerCase() === recipientKey
  // The other swept clones get records beside the event's and scans of their own, unless one is
  // planned on its own or is another account's.
  const others = [...sweptClones, ...movedClones].filter(
    (c) => c.address.toLowerCase() !== sipaAddress.toLowerCase(),
  )
  const extras = (
    await Promise.all(
      others.map(async (clone) => ({ clone, before: await recordAnywhere(deps, clone.address) })),
    )
  ).filter(
    ({ before }) =>
      !before ||
      (!before.messageSecret && before.recipientL2Address?.toLowerCase() === recipientKey),
  )
  const cloneFields = (clone: SweptClone): typeof fallback => ({
    ...fallback,
    origin: originFor(clone.implementation, clone.generation),
    ...(clone.intent ? { intent: clone.intent } : {}),
  })
  for (const { clone } of extras) file(clone.address, cloneFields(clone))

  // Judged on the records as they stood before this pass wrote them: a clone discovered now is in
  // flight.
  if (isInFlight(existing, run.now)) result.active += 1
  for (const { before } of extras) if (isInFlight(before, run.now)) result.active += 1
  const scanOf = (
    address: Address,
    own: {
      fallback: typeof fallback
      intent: typeof intent
      implementation: EthAddress
      discovered: boolean
    },
  ) => {
    const record = deps.store.get(address)
    return {
      deps,
      result,
      run,
      sipaAddress: address,
      fallback: own.fallback,
      record,
      phase: record?.phase ?? "broadcast",
      intent: own.intent,
      implementation: own.implementation,
      discovered: own.discovered,
      observed: observed.get(address.toLowerCase())!,
      /** Where this pass read the SIPA from: a failed scan re-reads from here. */
      fromBlock: window.fromBlock,
      /** This pass read the SIPA from its history start. */
      backfilled: window.backfilled,
      /**
       * Everything before this pass's window was already read: the window reaches the history
       * start, or this address rode the cursor to it. A clone another record's window first met
       * is read from its own history start before it rides the cursor.
       */
      complete: window.backfilled ? window.complete : !!record?.observedFrom,
    }
  }
  // A misfiled pin whose event moved to a clone planned on its own leaves the clone's scan to that plan.
  return [
    ...(misfiled && plannedOnItsOwn(existing)
      ? []
      : [scanOf(sipaAddress, { fallback, intent, implementation, discovered })]),
    ...extras.map(({ clone, before }) =>
      scanOf(clone.address, {
        fallback: cloneFields(clone),
        intent: clone.intent,
        implementation: clone.implementation,
        discovered: !before,
      }),
    ),
  ]
}

/** The rest of a due SIPA's sync, once the batched reads land. */
async function scanOne(due: DueScan): Promise<void> {
  const { deps, result, run, sipaAddress, fallback, record, phase } = due
  const { intent, observed } = due
  // History is dated by chain. A direct deposit's announcement writes its record before its deposit
  // is seen, so that record is history until its first deposit is ledgered.
  const discovered =
    due.discovered || !!(record?.replayed && record.direct && !record.sweeps?.length)

  // Funding attribution: the token-level sender of the first Transfer into the SIPA. Read only
  // until it is stamped. Isolated: attribution is auxiliary and must not fail the claim path.
  const fundingBlock =
    record?.fundingFromAddress || !observed.inflows
      ? undefined
      : await attributeFunding(deps, sipaAddress, run, observed.inflows).catch((err) => {
          run.incomplete()
          logger.warn("[sipaScan] funding attribution failed (will retry next sync):", err)
          return undefined
        })
  const sweeps = sweepsOf(due)

  // A deposit swept before the wallet's first scan skips the funding probe entirely, so the sweep
  // writes are where its fee lands. The read is a run-level immutable. It may not fail the write
  // it decorates: the claim it follows has already landed on L2, and a throw here would leave the
  // record marked unclaimed until a later pass reconciles it.
  const sweepFee = async (row: SipaRow): Promise<string | undefined> => {
    const stored = deps.store.get(sipaAddress) ?? record
    // A direct deposit has no sweep, so it pays no sweep fee.
    if (stored?.direct) return "0"
    const [read] = await Promise.allSettled([run.feeFor(sipaRecordIntent(intent), row, stored)])
    if (read.status !== "fulfilled") {
      run.incomplete()
      return undefined
    }
    return bigMax(read.value, BigInt(stored?.registrationFee ?? 0)).toString()
  }
  const feeBreakdown = async (row: SipaRow): Promise<Partial<SipaDeposit>> => {
    const stored = deps.store.get(sipaAddress) ?? record
    if (stored?.fee != null) return {}
    const fee = await sweepFee(row)
    return fee === undefined ? {} : { fee }
  }

  // Stamps a fee a failed read lost, so the deposit can show its net. The fee owes nothing to the
  // log, so it retries on every tick until it lands — the cursor moves past the sweep that would
  // otherwise carry it.
  const repriceIfUnpriced = async () => {
    const stored = deps.store.get(sipaAddress) ?? record
    if (!stored || stored.fee != null) return
    const patch = await feeBreakdown(pricedRow(deps, stored, intent))
    if (Object.keys(patch).length === 0) return
    observe(deps, sipaAddress, patch)
  }

  // Phases past a claim: every earlier one is priced by the funding probe below.
  const settledPhase = (deps.store.get(sipaAddress) ?? record)?.phase
  if (settledPhase === "claimed" || settledPhase === "pendingClaim") await repriceIfUnpriced()

  // A deposit is dated by its L1 funding transfer; a replayed one with none read, by its sweep.
  const datedBy = fundingBlock ?? (discovered ? sweeps[0]?.blockNumber : undefined)
  const startTime =
    datedBy === undefined ? undefined : await readBlockTimeMs(deps.publicClient, datedBy)
  if (startTime !== undefined) observe(deps, sipaAddress, { startTime })

  // What the address holds now in tokens its intent settles, swept or not: what the registration
  // tick and the screens read.
  const held = heldBalance(observed.balances, sipaIntentRows(deps.rows, intent)).toString()
  observe(deps, sipaAddress, { heldBalance: held })

  if (sweeps.length === 0 && (deps.store.get(sipaAddress) ?? record)?.direct) {
    // A direct deposit's key holds nothing and nothing sweeps it: until its deposit is seen, the
    // pass only notes the window it read.
    observe(deps, sipaAddress, covered(due))
    return
  }

  if (sweeps.length === 0) {
    // Each row's floor and ceiling at once, and settled: an RPC failure on one row must not cost the
    // event its funding and sweep reads, nor price a balance on another row. A table with no row
    // for the intent prices nothing, and the balance is still read.
    const factoryIntent = sipaRecordIntent(intent)
    const intentRows = deps.rows.filter((row) =>
      row.intents.includes(sipaIntentName(factoryIntent)),
    )
    const priceable = intentRows.length > 0
    const rows = priceable ? intentRows : deps.rows
    const terms = priceable
      ? await Promise.allSettled(
          rows.map(async (row) => {
            const [fee, cap] = await Promise.all([
              run.feeFor(factoryIntent, row, deps.store.get(sipaAddress) ?? record),
              run.txAmountCap(row),
            ])
            return { row, fee, cap }
          }),
        )
      : []
    const pricedRows = new Set(rows.filter((_, i) => terms[i]?.status === "fulfilled"))
    const answer =
      intent === "registration" ? deps.registrationScheduleFor?.(sipaAddress) : undefined
    // No schedule can sweep this address, so its balance is the user's to recover whatever the
    // floor reads say.
    const unsweepable = answer === "unsweepable"
    const schedule = answer === "unsweepable" ? undefined : answer
    const accepted = (balance: bigint) =>
      !unsweepable && (!schedule || balance >= registrationFloor(schedule))
    // A registration SIPA routes the schedule fee, which is at least the implementation's own.
    const registrationFee = BigInt(record?.registrationFee ?? 0)
    const routes = rows.flatMap((row, i) => {
      const read = terms[i]
      const fee = bigMax(read?.status === "fulfilled" ? read.value.fee : 0n, registrationFee)
      const txAmountCap = read?.status === "fulfilled" ? read.value.cap : 0n
      return [row.token, ...row.swapped].map((token) => ({
        token,
        settlesIn: row.token,
        fee,
        txAmountCap,
      }))
    })
    // `sweepable` covers the per-transaction window alone. The portal meters a global rate-limited
    // cap besides, which this sync does not read (`createSipaProcessingObserver` explains it), so a
    // balance inside the window can still be refused. An unpriced row's routes have no window.
    const { token: fundedWith, status: funding } = await readSipaFunding(deps.publicClient, {
      sipa: sipaAddress,
      routes,
      accepted,
      decided: schedule !== null,
      balances: observed.balances,
    })
    const fundedRow = sipaRowByFunding(rows, fundedWith.address)
    const priced = !!fundedRow && pricedRows.has(fundedRow)
    // The floor cannot be priced: an unread immutable would floor it at zero and make dust look
    // sweepable, or the registration's schedule is not in hand. The balance is recorded and the
    // phase held for a pass that can price it.
    const undecided = !priced || schedule === null
    const before = deps.store.get(sipaAddress) ?? record
    const fundedFee = priced
      ? routes.find((r) => r.token === fundedWith)!.fee.toString()
      : undefined
    // Capture the gross funding + fee here — the third-party flow has no hook
    // to stamp them, and this is the only point both are in hand before a
    // sweep overwrites `amount` with the net. An unpriced pass writes neither, and the UI shows
    // the gross until a later pass reads the fee. Funds first seen with no funding block to date
    // them start the record's clock: the feed sorts it as new and the overdue sweep counts from then.
    const funded = {
      ...(funding.balance > 0n && startTime === undefined && before && isUnfundedSipaDeposit(before)
        ? { startTime: run.now }
        : {}),
      amount: formatUnits(funding.balance, fundedWith.decimals),
      fee: feeOnRow(deps, before, intent, fundedRow, fundedFee),
      tokenAddress: fundedWith.address,
      rowToken:
        fundedRow && fundedRow.token.address !== fundedWith.address
          ? fundedRow.token.address
          : undefined,
      tokenSymbol: fundedWith.symbol,
      tokenDecimals: fundedWith.decimals,
      fundingTokenSymbol: fundedWith.symbol,
    }
    // A listed sweep the observation no longer shows is dropped here.
    const scanned = covered(due)
    const paidAgain = funding.balance > 0n && !!before && claimedBefore(before)
    // A new payment to a claimed address: the claimed one stays in the ledger, and the record's
    // own fields describe the new one, with no sweep yet. It is dated by its L1 transfer, the
    // latest into the address, or by now when none was read.
    const paidAt = paidAgain ? await latestInflowTime(deps.publicClient, observed) : undefined
    const reopened = paidAgain
      ? {
          startTime: paidAt ?? run.now,
          endTime: undefined,
          netAmount: undefined,
          sweepTxHash: undefined,
        }
      : {}
    const resweepable = (before?.origin ?? fallback.origin)?.resweepable !== false
    if (unsweepable && funding.balance > 0n) {
      // recoverERC20 is the only exit and it owes nothing to the fee reads, so this outranks an
      // unpriced pass — holding here would pin the record short of every recovery entry point.
      observe(deps, sipaAddress, { phase: "recoverable", ...funded, ...scanned, ...reopened })
      result.recoverable += 1
    } else if (undecided && funding.balance > 0n) {
      run.incomplete()
      observe(deps, sipaAddress, { phase, ...funded, ...scanned })
    } else if (funding.balance > 0n && (!funding.sweepable || (paidAgain && !resweepable))) {
      // Outside the sweep window — the balance is at or below the sweep fee, or what clears it
      // exceeds the per-transaction cap — or a second payment to an address that refuses a second
      // sweep. No sweep moves it.
      observe(deps, sipaAddress, { phase: "recoverable", ...funded, ...scanned, ...reopened })
      result.recoverable += 1
    } else if (paidAgain) {
      // The record keeps its claim until it can owe the broadcast again: the two commit together.
      // Its re-read point does not wait, since the cursor moves on regardless.
      const held = () => {
        if (scanned.rescanFrom) observe(deps, sipaAddress, { rescanFrom: scanned.rescanFrom })
      }
      if (deps.republishes === false) return held()
      const sinceBlock = await republishFrom(run)
      if (sinceBlock === undefined) return held()
      observe(deps, sipaAddress, { phase: "sweeping", ...funded, ...scanned, ...reopened })
      // This owe is the interval's ask: a payment dated an hour back is not overdue next pass.
      deps.store.apply(sipaAddress, { type: "republishDue", at: run.now })
      deps.store.apply(sipaAddress, { type: "broadcastRepublish", sinceBlock, at: run.now })
    } else if (funding.balance > 0n) {
      observe(deps, sipaAddress, { phase: "sweeping", ...funded, ...scanned })
      await republishIfOverdue(deps, run, sipaAddress)
    } else {
      // No sweep moves ETH, so any at a never-swept address is the user's to recover. The sweep
      // window is only the recent blocks, so a claimed deposit reads as unswept here too. A failed
      // read throws: falling through would heal a `recoverable` ETH record to `recovered`.
      const stored = deps.store.get(sipaAddress) ?? record
      const swept =
        !!stored?.sweepTxHash || !!stored?.inboxIndex || !!stored?.claimedInboxIndexes?.length
      const eth = swept
        ? 0n
        : observed.balances.get(NATIVE_ETH.address) ??
          (await deps.publicClient.getBalance({ address: sipaAddress }))
      if (eth > 0n) {
        observe(deps, sipaAddress, {
          phase: "recoverable",
          amount: formatUnits(eth, NATIVE_ETH.decimals),
          // A token fee read on an earlier pass would price the ETH.
          fee: undefined,
          netAmount: undefined,
          tokenAddress: NATIVE_ETH.address,
          rowToken: undefined,
          tokenSymbol: NATIVE_ETH.symbol,
          tokenDecimals: NATIVE_ETH.decimals,
          ...scanned,
        })
        result.recoverable += 1
        return
      }
      const recovery = observed.recoveries.at(-1)
      if (recovery) {
        observe(deps, sipaAddress, {
          phase: "recovered",
          recoveryTxHash: recovery.txHash,
          ...scanned,
        })
        return
      }
      // Only a recovery empties a SIPA without emitting a `Sweep`, so a `recoverable` one
      // now at zero was recovered — including by a submission whose receipt wait never returned.
      // The hash stamped at submission survives; none is invented here. A recovery that settled
      // the record meanwhile keeps it: reopening it takes new funds.
      const latest = deps.store.get(sipaAddress)
      const current = latest?.phase ?? phase
      const healed = current === "recoverable" && !latest?.claimedInboxIndexes?.length
      observe(deps, sipaAddress, { phase: healed ? "recovered" : current, ...scanned })
    }
    return
  }

  // Each unclaimed sweep keeps its claim inputs, its time and its fee, so the claim half claims it
  // without reading L1, however far the cursor moves.
  const pending: SIPAPendingSweep[] = []
  const claimedIndexes = new Set(record?.claimedInboxIndexes ?? [])

  for (const sweep of sweeps) {
    const indexKey = sweep.index.toString()
    const claimed = claimedIndexes.has(indexKey)
    if (claimed && deps.store.get(sipaAddress)?.sweeps?.some((s) => s.inboxIndex === indexKey)) {
      await repriceIfUnpriced()
      continue
    }

    // The sweep's block dates its ledger entry. A replayed deposit also settles there, whether this
    // device claims it or an earlier one did; a deposit already on record settles when its claim
    // lands.
    const sweptAt = await readBlockTimeMs(deps.publicClient, sweep.blockNumber)
    const row = sipaSweepRow(deps.tuple, deps.rows, sweep, intent)
    // What the sweep took out of the SIPA: which token, since a re-used address can be funded again
    // in another one and attribution names only its first funding, and how much, every funding
    // transfer it settled. A row with one accepted token needs no read for its name, so a failed
    // read then only leaves the gross unknown.
    const tokens = [row.token, ...row.swapped]
    const saved = sweep.funding
    const savedToken = saved
      ? tokens.find((t) => t.address.toLowerCase() === saved.token.toLowerCase())
      : undefined
    const found =
      sweptFunding(observed.outflows, sweep.txHash, tokens) ??
      (savedToken ? { token: savedToken, gross: saved!.gross } : undefined)
    const swept = tokens.length === 1 ? { token: row.token, gross: found?.gross } : found
    // Only the device that started a registration stores its fee, so another device reads it off
    // the first sweep: what it took less what it credited, tag price included. Amounts in two
    // tokens can't be subtracted, so a registration paid in a swapped token stays unpriced.
    const before = deps.store.get(sipaAddress) ?? record
    if (
      intent === "registration" &&
      before?.registrationFee === undefined &&
      !before?.sweeps?.length &&
      sweep === sweeps[0] &&
      swept?.gross !== undefined &&
      swept.gross >= sweep.amount &&
      swept.token.address.toLowerCase() === row.token.address.toLowerCase()
    )
      observe(deps, sipaAddress, { registrationFee: (swept.gross - sweep.amount).toString() })
    // A sweep's fee is its own row's, read for this pass; the record's fee is its latest sweep's. A
    // sweep keeps the fee a pass already saved for it, since the owner may reprice the row before
    // the claim.
    const stored = deps.store.get(sipaAddress) ?? record
    const fee =
      stored?.inboxIndex === indexKey &&
      stored.fee != null &&
      pricedRow(deps, stored, intent) === row
        ? stored.fee
        : feeOnRow(deps, stored, intent, row, await sweepFee(row))

    // A sweep claimed before the ledger existed gets its entry from these reads.
    if (claimed) {
      await repriceIfUnpriced()
      observe(deps, sipaAddress, {}, sipaLedgerEntry(row, toPending(sweep, swept, sweptAt, fee)))
      continue
    }

    // A saved sweep of the same message keeps what an earlier pass confirmed: a failed read here
    // must not clear it.
    const earlier = record?.pendingSweeps?.find(
      (s) => s.inboxIndex === indexKey && s.messageKey === sweep.messageKey,
    )
    const left = {
      ...earlier,
      ...toPending(sweep, swept, sweptAt, fee, discovered ? sweptAt : undefined),
    }
    pending.push(left)
    run.pending.push({ sweep: left, l2Token: row.l2Token })
    run.record(() =>
      observe(deps, sipaAddress, {
        phase: "pendingClaim",
        ...sipaSweepFields(sipaLedgerEntry(row, left)),
      }),
    )
    result.pendingSettlement += 1
  }

  // Queued after this SIPA's own events: what it covers reads what they leave.
  run.record(() => observe(deps, sipaAddress, covered(due, pending)))
}

/**
 * Marks the pending sweeps whose deposits were already spent, on this device or another, in one
 * nullifier lookup per row token, before the pass writes them. A spent deposit never reads as
 * arriving, and the claim run settles it with no claim. A failed lookup leaves each to its claim.
 */
async function markSpent(
  deps: PassDeps,
  pending: readonly { sweep: SIPAPendingSweep; l2Token: string }[],
): Promise<void> {
  const byToken = new Map<string, SIPAPendingSweep[]>()
  for (const { sweep, l2Token } of pending) {
    const key = l2Token.toLowerCase()
    byToken.set(key, [...(byToken.get(key) ?? []), sweep])
  }
  const readConsumed =
    deps.readConsumed ??
    ((l2Token: AztecAddress, keys: readonly Hex[]) =>
      readSipaDepositsConsumed(
        deps.node,
        { l2Token, masterNullifierHidingKey: deps.masterNullifierHidingKey },
        keys,
      ))
  await Promise.all(
    [...byToken].map(async ([l2Token, sweeps]) => {
      try {
        const found = await readConsumed(
          AztecAddress.fromStringUnsafe(l2Token),
          sweeps.map((sweep) => sweep.messageKey),
        )
        found.forEach((spent, i) => {
          if (spent) sweeps[i]!.spent = true
        })
      } catch (err) {
        logger.warn("[sipaScan] spent-deposit lookup failed; the claim run claims each:", err)
      }
    }),
  )
}

/** A sweep's claim inputs as the record keeps them. */
function toPending(
  sweep: PassSweep,
  swept: { token: SipaFundingToken; gross?: bigint } | undefined,
  sweptAt: number | undefined,
  fee: string | undefined,
  settledAt?: number,
): SIPAPendingSweep {
  return {
    inboxIndex: sweep.index.toString(),
    amount: sweep.amount.toString(),
    messageKey: sweep.messageKey,
    blockNumber: sweep.blockNumber.toString(),
    sweepTxHash: sweep.txHash,
    ...(sweep.portal ? { portal: sweep.portal } : {}),
    ...(swept ? { fundingToken: swept.token.address } : {}),
    ...(swept?.gross === undefined ? {} : { grossAmount: swept.gross.toString() }),
    ...(sweptAt === undefined ? {} : { sweptAt }),
    ...(fee === undefined ? {} : { fee }),
    ...(settledAt === undefined ? {} : { settledAt }),
  }
}

/** The token a sweep through `row` took out of its SIPA. */
function fundingTokenOf(row: SipaRow, sweep: SIPAPendingSweep): SipaFundingToken | undefined {
  const token = sweep.fundingToken?.toLowerCase()
  return [row.token, ...row.swapped].find((t) => t.address.toLowerCase() === token)
}

/** `sweep`'s ledger entry once settled on `row`: its amounts are in the row token's units. */
export function sipaLedgerEntry(row: SipaRow, sweep: SIPAPendingSweep): SIPASweep {
  const funding = fundingTokenOf(row, sweep)
  return {
    inboxIndex: sweep.inboxIndex,
    sweepTxHash: sweep.sweepTxHash,
    netAmount: sweep.amount,
    messageKey: sweep.messageKey,
    ...sipaRowCredit(row),
    ...(sweep.fee === undefined ? {} : { fee: sweep.fee }),
    ...(sweep.sweptAt === undefined ? {} : { settledAt: sweep.sweptAt }),
    ...(funding
      ? { fundingTokenSymbol: funding.symbol, fundingTokenDecimals: funding.decimals }
      : {}),
    ...(sweep.grossAmount === undefined || !funding ? {} : { grossAmount: sweep.grossAmount }),
  }
}

/**
 * What a finished scan stamps: its whole history read once, any re-read cleared, the sweeps it left
 * unclaimed. Empty when nothing changes, so a quiet SIPA writes nothing.
 */
function covered(due: DueScan, pending: SIPAPendingSweep[] = []): SipaObservation {
  const stored = due.deps.store.get(due.sipaAddress) ?? due.record
  const patch: SipaObservation = {}
  if (due.complete && (due.backfilled || !stored?.observedFrom))
    patch.observedFrom = due.run.head.toString()
  const retry = due.run.retryFrom.get(due.sipaAddress.toLowerCase())
  if (retry !== undefined) patch.rescanFrom = retry.toString()
  else if (stored?.rescanFrom) patch.rescanFrom = undefined
  const same = JSON.stringify(stored?.pendingSweeps ?? []) === JSON.stringify(pending)
  if (!same) patch.pendingSweeps = pending.length ? pending : undefined
  return patch
}

/** The L2 block a broadcast owed again must land from; undefined, for a later pass, if unread. */
async function republishFrom(run: SyncRunContext): Promise<number | undefined> {
  const block = await bestEffort("unknown", run.l2Head())
  if (block === undefined) run.incomplete()
  return block
}

/**
 * Owes a funded SIPA's broadcast again when the relayer has left it unswept past
 * `SWEEP_OVERDUE_MS`: it dropped the operation (after 14 days) or never had it.
 */
async function republishIfOverdue(deps: PassDeps, run: SyncRunContext, sipa: Address) {
  const record = deps.store.get(sipa)
  if (deps.republishes === false || !record || run.now - record.startTime < SWEEP_OVERDUE_MS) return
  if (record.republishAskedAt && run.now - record.republishAskedAt < REPUBLISH_INTERVAL_MS) return
  const sinceBlock = await republishFrom(run)
  if (sinceBlock === undefined) return
  // Once per interval whatever it owes: an address with nothing to rebuild owes nothing each time.
  deps.store.apply(sipa, { type: "republishDue", at: run.now })
  deps.store.apply(sipa, { type: "broadcastRepublish", sinceBlock, at: run.now })
}

/** The L1 block time of the latest transfer into a SIPA, ms epoch. */
async function latestInflowTime(
  publicClient: PublicClient,
  { inflows }: ObservedSipa,
): Promise<number | undefined> {
  const latest = inflows?.reduce<bigint | undefined>(
    (max, flow) => (max === undefined || flow.blockNumber > max ? flow.blockNumber : max),
    undefined,
  )
  return latest === undefined ? undefined : readBlockTimeMs(publicClient, latest)
}

/**
 * Whether the funds now at this SIPA come after a claimed sweep. Besides `claimed`, a `sweeping`
 * record still stamped with its claimed sweep (settled time, claimed inbox index) qualifies: a
 * second payment once left the record so, with no stuck clock and no exit.
 */
function claimedBefore(
  record: Pick<SipaDeposit, "phase" | "endTime" | "inboxIndex" | "claimedInboxIndexes">,
): boolean {
  if (record.phase === "claimed") return true
  return (
    record.phase === "sweeping" &&
    !!record.endTime &&
    !!record.inboxIndex &&
    !!record.claimedInboxIndexes?.includes(record.inboxIndex)
  )
}

/**
 * What `balances` (keyed by lowercased token) hold at most, in units of the row each token settles on:
 * the balance a sweep of the largest holding would credit.
 */
function heldBalance(balances: ReadonlyMap<string, bigint>, rows: readonly SipaRow[]): bigint {
  let best = { held: 0n, comparable: 0n }
  for (const row of rows) {
    for (const token of [row.token, ...row.swapped]) {
      const held = inRowUnits(balances.get(token.address.toLowerCase()) ?? 0n, token, row.token)
      const comparable = held * 10n ** BigInt(Math.max(36 - row.token.decimals, 0))
      if (comparable > best.comparable) best = { held, comparable }
    }
  }
  return best.held
}

/** The row a record's stored fee was priced on: its funds' row, or before any funds, the default one. */
function pricedRow(deps: PassDeps, stored: SipaDeposit, intent: SipaDeposit["intent"]): SipaRow {
  return (
    sipaRowByFunding(deps.rows, stored.tokenAddress) ??
    sipaDefaultRow(deps.tuple, deps.rows, intent)
  )
}

/**
 * The fee a record names once its funds or its sweep sit on `row`: `fresh`, read off that row, else the
 * stored fee when it was priced on that row. A fee priced on another row goes until a pass prices this one.
 */
function feeOnRow(
  deps: PassDeps,
  stored: SipaDeposit | null,
  intent: SipaDeposit["intent"],
  row: SipaRow | undefined,
  fresh: string | undefined,
): string | undefined {
  if (fresh !== undefined) return fresh
  return stored?.fee != null && row && pricedRow(deps, stored, intent) === row
    ? stored.fee
    : undefined
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}
