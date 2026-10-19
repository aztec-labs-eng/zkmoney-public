/**
 * SIPA deposit sync — discovery → claim → spendable, the recipient-side
 * composition over the sdk primitives and the front-core crypto/store:
 *
 *   1. read the recipient's `SIPA` events (`shared_secret_salt` + `resweepable`)
 *      off the token (requires `setupSipaDiscovery` to have registered the
 *      senders in this PXE),
 *   2. per event, derive the recipient commitment + recoveryAddress and compute
 *      the SIPA address offline — that address locates the L1 `Sweep` log that
 *      supplies the claim inputs,
 *   3. for each unclaimed `Sweep`, extract the L1→L2 message key from the
 *      sweep tx and wait for settlement (`store_deposit` asserts
 *      the settled root, so claiming earlier just fails),
 *   4. claim via `TokenService.claimSweptDeposit` — after which
 *      `balance_of` reflects the net amount and the next transfer spends it.
 *
 * Alongside, the first `Transfer(to = sipa)` in the scan window stamps the
 * funding attribution (funder address + tx) and fires the deposit-attested
 * contact hook — read once per SIPA, then never again.
 *
 * Known SIPAs keep being scanned, since a claimed SIPA can be paid again; claims dedup by inbox
 * index. The relayer sweeps an address once per publish, so new funds on a claimed SIPA reopen
 * its record and ask the caller to publish it again (`onSweptAddressFunded`); an address that is
 * not resweepable can only be recovered. A funded SIPA whose balance is at or below the deposit
 * floor — the relayer's sweep fee plus the portal's funding cut — can never be
 * swept, so it flips to `recoverable`, surfacing the `recoverERC20` exit.
 *
 * Addresses are single-use and permanent, so the watched set only grows. Scan
 * work is rationed against that: each SIPA resumes from the block it was last
 * scanned through, and one whose next event is not imminent (settled, replayed
 * onto this device and never funded, or old and never funded) drops to a slow
 * lane. `SipaDepositSyncResult.active` reports what is left on the fast lane,
 * so the caller's poll interval follows.
 *
 * A fresh device replays every sweep in the account's history. So a pass reads each receipt, block
 * and message readiness once, starts them all before its first claim, and reads the balance once
 * after its last: only the claims themselves queue on the PXE one at a time.
 *
 * Per-event failures are isolated: one bad SIPA must not stall the rest.
 * Pure over injected collaborators; shared by every wallet front end.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { Wallet } from "@aztec/aztec.js/wallet"
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import { EthAddress } from "@aztec/foundation/eth-address"
import { keccak256 } from "@aztec/foundation/crypto/keccak"
import { Fr } from "@aztec/aztec.js/fields"
import { canonicalGenerationStack } from "src/core"
import { formatUnits, type Address, type Hex, type PublicClient } from "viem"
import type { OxideEnvTuple, RegistrationSchedule } from "@obsidion/core/types"
import { registrationFloor } from "@obsidion/core/constants"
import {
  fetchSipaEvents,
  isAlreadyClaimedDepositError,
  readBlockTimeMs,
  readDepositFee,
  readDepositMessageKey,
  readFpcFundingCut,
  readFundingTransfersMany,
  readRecoveredEvents,
  readRecoveredEventsMany,
  readSipaBalancesMany,
  readSweepEvents,
  readSweepEventsMany,
  type SipaEvent,
  type SipaFundingTransfer,
  type SipaRecoveredEvent,
  type SipaSweepEvent,
  type TokenService,
} from "@obsidion/sdk"
import { logger } from "src/utils/logger"

import { computeSIPAAddress as computeAccountSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { computeSIPAAddress } from "../core/services/deposits/sipa/sipaAddress"
import { isAlreadyClaimedError } from "./depositClaimErrors"
export { isAlreadyClaimedError }
import { depositSipaImplementation, registrationSipaImplementation } from "./sipaImplementations"
import {
  firstFunding,
  NATIVE_ETH,
  readFirstFunding,
  readSipaFunding,
  readSweptFunding,
  type SipaFundingToken,
} from "./sipaFunding"
import {
  computeStealthRecipientHash,
  deriveRecoveryAddress,
  type SipaK1Point,
} from "../core/services/deposits/sipa/stealth"
import {
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  type SIPADepositRecord,
  type SIPASweep,
  type SIPADepositStore,
} from "../core/services/deposits/SIPADepositStore"
import { globalEventEmitter } from "../core/services/GlobalEventEmitter"

/** Node surface for the settlement check — the union of the v4 (`getBlock`) and
 * v5 (`getBlockData`) readiness reads; only the generation's own pair is called. */
export interface SipaClaimsNode {
  getL1ToL2MessageCheckpoint(messageHash: Fr): Promise<number | undefined>
  getBlock?(tag: string): Promise<{ checkpointNumber: number } | undefined>
  getBlockData?(tag: string): Promise<unknown>
}

/**
 * Overlap re-read on a resumed scan, so a `Sweep` cannot fall between two windows when
 * the head it was measured against is reorged away. Re-reading a claimed sweep costs
 * nothing (inbox-index dedup); missing one strands the deposit.
 */
const SCAN_REORG_OVERLAP_BLOCKS = 128n

/** How long a SIPA stays on the per-tick lane after discovery. */
const FRESH_SCAN_WINDOW_MS = 10 * 60_000

/**
 * Slow-lane cadence. These SIPAs are still scanned, since a claimed one can be paid again,
 * just not every tick.
 */
const SLOW_SCAN_INTERVAL_MS = 5 * 60_000

/**
 * Whether `record`'s next event is imminent enough to spend a scan on this tick.
 * A missing record is an event discovered just now, which always is. A replayed one is
 * history replayed onto this device, so nothing is due on it either.
 */
/** Whether a record is due a scan this run: on the fast lane, or past the slow lane's interval. */
function scanDue(record: SIPADepositRecord | null, now: number): boolean {
  return isFastLane(record, now) || now - (record?.lastScanAt ?? 0) >= SLOW_SCAN_INTERVAL_MS
}

function isFastLane(record: SIPADepositRecord | null, now: number): boolean {
  if (!record) return true
  // A sweep or an L1->L2 settlement is in flight; both land in minutes.
  if (record.phase === "sweeping" || record.phase === "pendingClaim") return true
  if (isSettledSipaPhase(record.phase)) return false
  if (record.replayed) return false
  return now - record.startTime < FRESH_SCAN_WINDOW_MS
}

/** Generation-aware L1→L2 message readiness: the v4 node client predates
 * `getBlockData`, so the v5 `isL1ToL2MessageReady` throws on it — replicate the
 * frozen 4.3.0 check (first block of a settled checkpoint) instead. */
async function isSweepMessageReady(node: SipaClaimsNode, messageHash: Fr): Promise<boolean> {
  if (canonicalGenerationStack() === "v4") {
    const checkpoint = await node.getL1ToL2MessageCheckpoint(messageHash)
    if (checkpoint === undefined) return false
    const latest = await node.getBlock!("latest")
    return latest !== undefined && latest.checkpointNumber >= checkpoint
  }
  return isL1ToL2MessageReady(node as never, messageHash as never)
}

/** The funder proven by the on-chain funding transfer — the legacy gateway hook's shape. */
export interface SipaFundingWalletDetected {
  address: Address
  walletName?: string
  walletImageUrl?: string
  walletProvider?: string
  lastUsedAt?: number
}

/**
 * What a wallet can say about a registration SIPA's pricing:
 *
 * - a `RegistrationSchedule` — ours, and its sweep is priced against these amounts;
 * - `"unsweepable"` — ours, and no schedule can ever sweep it (the controller pays exactly the fee
 *   the address commits to), so any balance there is recoverable;
 * - `null` — ours, schedule not in hand; hold the phase for a pass that can price it;
 * - `undefined` — not ours: a plain deposit, classified on the fee and the cut alone.
 */
export type RegistrationScheduleAnswer = RegistrationSchedule | "unsweepable" | null | undefined

export interface SipaDepositSyncDeps {
  publicClient: PublicClient
  /** Node handle for the settlement check (`isSweepMessageReady`). */
  node: SipaClaimsNode
  /** Reads the recipient's `SIPA` events off the token. */
  wallet: Pick<Wallet, "getPrivateEvents">
  tokenService: Pick<TokenService, "claimSweptDeposit">
  /**
   * Reads the balance after a claim lands in the PXE. The claim is recorded once this settles, so
   * the balance holds the deposit before its record reads `claimed`. A failed read is logged and the
   * claim recorded anyway.
   */
  refreshBalance?: () => Promise<void>
  /** Items the pass has checked, once its events are read and the total is known. */
  onProgress?: (done: number, total: number) => void
  store: Pick<SIPADepositStore, "get" | "upsert" | "list" | "remove">
  tuple: OxideEnvTuple
  /** The recipient account this PXE discovers events for. */
  recipient: AztecAddress
  /** The user's stealth public key (`deriveStealthKey(masterSecret).publicKey`). */
  stealthPublicKey: SipaK1Point
  recoveryAccount?: Address
  /** L1 token the deposits are credited in (the fee's denomination; display metadata for the record). */
  token: SipaFundingToken
  /**
   * Every L1 token a SIPA may be FUNDED with, when the sweep accepts more than `token` (mainnet
   * swaps USDC/USDT into DAI). Funding attribution and the pre-sweep probe scan all of them.
   * Defaults to `[token]`.
   */
  fundingTokens?: SipaFundingToken[]
  l1ChainId: number
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
  historyStartBlock?: () => Promise<bigint>
  /**
   * A claimed SIPA holds new funds. The relayer sweeps it again only after a newer publish on
   * Aztec, so the caller publishes it again. Fired once, when the record reopens.
   */
  onSweptAddressFunded?: (sipaAddress: Address) => Promise<void>
}

export interface SipaDepositSyncResult {
  /** Distinct SIPAs discovered from `SIPA` events this run. */
  discovered: number
  /**
   * SIPAs on the per-tick scan lane. Zero means nothing is expected to change soon and
   * the caller can poll slowly.
   */
  active: number
  /** SIPAs the slow lane skipped this run — the scan work deliberately not done. */
  skipped: number
  /** Sweeps claimed into the PXE this run (balance-visible). */
  claimed: number
  /** Sweeps found but not yet settled L1→L2 — retried next sync. */
  pendingSettlement: number
  /** SIPAs stuck under the fee floor — recoverERC20 is the exit. */
  recoverable: number
  /**
   * Sweeps the PXE had already claimed but the local record hadn't marked
   * (crash between claim and store write, store restore) — reconciled, not
   * re-claimed.
   */
  reconciled: number
  /** Events or sweeps that failed this run (isolated; retried next sync). */
  failed: number
}

export async function syncSipaDeposits(
  callerDeps: SipaDepositSyncDeps,
): Promise<SipaDepositSyncResult> {
  const deps = { ...callerDeps, publicClient: passClient(callerDeps.publicClient) }
  const { tuple } = deps
  if (!tuple.sipaFactory || !tuple.portal) {
    throw new Error(
      "oxide manifest lacks the SIPA surface (sipaFactory / portal) — " +
        "SIPA deposit sync requires a dev.json-shaped deployment",
    )
  }
  if (!/^\d+$/.test(tuple.rollupVersion ?? "")) {
    throw new Error(
      `oxide manifest has a missing or non-numeric rollupVersion ("${tuple.rollupVersion}") — ` +
        "the SIPA CREATE2 derivation binds to it",
    )
  }

  const result: SipaDepositSyncResult = {
    discovered: 0,
    active: 0,
    skipped: 0,
    claimed: 0,
    pendingSettlement: 0,
    recoverable: 0,
    reconciled: 0,
    failed: 0,
  }

  // A received deposit is the deposit intent, so its clone delegates to the factory's deposit
  // implementation; the offline address derivation needs it. The portal's pointer is read rather than
  // the tuple's `depositSIPAImplementation` on purpose: this rail follows the live generation, and
  // the pointer is what the deposit-address side sent the payer to. Retired generations are the
  // historic probe's job, and it must not read this pointer at all.
  const depositImplementation = EthAddress.fromString(
    await depositSipaImplementation(
      deps.publicClient,
      tuple.sipaFactory as Address,
      tuple.portal as Address,
    ),
  )

  const events = await fetchSipaEvents(
    deps.wallet,
    AztecAddress.fromStringUnsafe(tuple.l2Token),
    deps.recipient,
  )
  const seen = new Set<string>()
  const kinds = await Promise.all(events.map((event) => eventKind(event, deps.recipient)))
  const eventKey = (i: number) => pinKey(events[i]!.sharedSecretSalt.toString(), kinds[i]!)

  // A self-initiated SIPA's record was written at derivation, before its event existed. Index those
  // records by salt and intent kind so an event and its record never disagree on the address. A
  // registration restarted at another fee reuses its salt at a new address, so one key can pin
  // several. An upgrade's update-metadata SIPA and its subscription's DepositSIPA share a salt; the
  // kind keeps them apart.
  const localByKey = new Map<string, Address[]>()
  for (const r of deps.store.list()) {
    if (!r.messageSecret) continue
    for (const kind of recordKinds(r)) {
      const key = pinKey(r.messageSecret, kind)
      localByKey.set(key, [...(localByKey.get(key) ?? []), r.sipaAddress])
    }
  }

  // One head bounds every SIPA's scan this run, and is what each persists as scanned-through — so
  // `cacheTime: 0`, since viem's default caches it for a polling interval. A lagging head both hides
  // the newest sweeps and gets persisted as the cursor, and the reorg overlap is the only thing that
  // would ever walk back over them.
  const head = await deps.publicClient.getBlockNumber({ cacheTime: 0 })
  const now = Date.now()

  // Priced off the implementation the address derives from, one read per implementation per run —
  // and none at all if no SIPA reaches the probe. A failed read is dropped from the map, so one
  // transient RPC error leaves only its own event unpriced.
  const fees = new Map<string, Promise<bigint>>()
  const feeFor = (implementation: EthAddress) => {
    const key = implementation.toString() as Address
    const cached = fees.get(key)
    if (cached) return cached
    const pending = readDepositFee(deps.publicClient, key)
    fees.set(key, pending)
    pending.catch(() => {
      if (fees.get(key) === pending) fees.delete(key)
    })
    return pending
  }
  const registrationImplementation = () =>
    registrationSipaImplementation(
      deps.publicClient,
      tuple.sipaFactory as Address,
      tuple.portal as Address,
    ).then((address) => EthAddress.fromString(address))
  // The other half of the deposit floor. A per-deployment immutable, so one lazy read per run.
  let cutRead: Promise<bigint> | undefined
  const fpcFundingCut = () => {
    if (!cutRead) {
      const pending = (cutRead = readFpcFundingCut(deps.publicClient, tuple.portal as Address))
      pending.catch(() => {
        if (cutRead === pending) cutRead = undefined
      })
    }
    return cutRead
  }
  const fundingTokens = deps.fundingTokens?.length ? deps.fundingTokens : [deps.token]
  let startRead: Promise<bigint | undefined> | undefined
  const historyStart = () =>
    (startRead ??= (deps.historyStartBlock?.() ?? Promise.resolve(undefined)).catch((err) => {
      logger.warn("[sipaClaims] history start read failed, using the default look-back:", err)
      return undefined
    }))
  const recordWrites: (() => Promise<void>)[] = []
  let claims = 0
  const ready = new Map<string, Promise<boolean>>()
  const messageKeys = new Map<string, Promise<unknown>>()
  const run: SyncRunContext = {
    head,
    now,
    feeFor,
    registrationImplementation,
    fpcFundingCut,
    fundingTokens,
    historyStart,
    record: (write) => void recordWrites.push(write),
    claimed: (write) => {
      claims += 1
      recordWrites.push(write)
    },
    messageKey: (sweep) => {
      const key = `${sweep.txHash.toLowerCase()}:${sweep.index}`
      const cached = messageKeys.get(key)
      if (cached) return cached
      const pending = Promise.resolve().then(() =>
        readDepositMessageKey(
          deps.publicClient as never,
          tuple.portal as never,
          sweep.txHash as never,
          sweep.index,
        ),
      )
      messageKeys.set(key, pending)
      pending.catch(() => {
        if (messageKeys.get(key) === pending) messageKeys.delete(key)
      })
      return pending
    },
    messageReady: (messageKey) => {
      const key = String(messageKey)
      const cached = ready.get(key)
      if (cached) return cached
      const pending = isSweepMessageReady(deps.node, messageKey as never)
      ready.set(key, pending)
      pending.catch(() => {
        if (ready.get(key) === pending) ready.delete(key)
      })
      return pending
    },
  }

  const replaying = events.some((_, i) => !localByKey.has(eventKey(i)))
  // A pass that discovers events with no local record is replaying history onto this device, so it
  // holds the balance and activity placeholders until its claims have refreshed the chain view.
  // Otherwise it only joins a catch-up already in progress.
  const end =
    replaying || globalEventEmitter.isSyncCatchingUp()
      ? globalEventEmitter.beginSyncCatchUp()
      : undefined
  const recipientKey = deps.recipient.toString().toLowerCase()
  const eventPins = new Map<string, number>()
  events.forEach((_, i) => {
    const key = eventKey(i)
    if (!eventPins.has(key)) eventPins.set(key, localByKey.get(key)?.length ?? 1)
  })
  const recordItems = deps.store
    .list()
    .filter(
      (r) =>
        !!r.messageSecret &&
        !isSettledSipaPhase(r.phase) &&
        r.recipientL2Address?.toLowerCase() === recipientKey &&
        !recordSeen({ ...r, messageSecret: r.messageSecret }, new Set(eventPins.keys())),
    ).length
  const total = [...eventPins.values()].reduce((sum, n) => sum + n, 0) + recordItems
  let done = 0
  const stepProgress = () => deps.onProgress?.(Math.min(++done, total), total)
  deps.onProgress?.(0, total)

  // Every due SIPA is found first, so its L1 reads batch with the rest; then each scan runs alone.
  const due: DueScan[] = []
  const plan = async (label: string, prepare: () => Promise<DueScan | undefined>) => {
    try {
      const scan = await prepare()
      if (scan) {
        due.push(scan)
        return
      }
    } catch (err) {
      result.failed += 1
      logger.warn(`[sipaClaims] ${label} sync failed (will retry next sync):`, err)
    }
    stepProgress()
  }

  try {
    for (const [i, event] of events.entries()) {
      const key = eventKey(i)
      if (seen.has(key)) continue
      seen.add(key)
      const pins = localByKey.get(key) ?? [undefined]
      for (const pin of pins) {
        await plan("event", () =>
          syncOneEvent(deps, event, depositImplementation, result, run, pin),
        )
      }
    }

    // Records are the authoritative list of self-initiated SIPAs, so one whose event is absent
    // (discovery raced the broadcast, PXE reset) still syncs — synthesized into the same pipeline,
    // pinned to its recorded address.
    for (const r of deps.store.list()) {
      if (!r.messageSecret || isSettledSipaPhase(r.phase)) continue
      if (r.recipientL2Address?.toLowerCase() !== recipientKey) continue
      if (recordSeen({ ...r, messageSecret: r.messageSecret }, seen)) continue
      const secret = r.messageSecret
      await plan("record", () => {
        const pseudo: SipaEvent = {
          sharedSecretSalt: Fr.fromString(secret),
          resweepable: false,
          intentHash: NO_EVENT_INTENT,
        }
        return syncOneEvent(deps, pseudo, depositImplementation, result, run, r.sipaAddress)
      })
    }

    const reads = await readDueScans(deps, run, due)
    await prefetchSweepReads(deps, run, due, reads)
    for (const scan of due) {
      try {
        await scanOne(scan, reads)
      } catch (err) {
        result.failed += 1
        logger.warn(`[sipaClaims] ${scan.sipaAddress} sync failed (will retry next sync):`, err)
      } finally {
        stepProgress()
      }
    }
    // One balance read covers every claim this pass made; each still reads `claimed` only after it.
    if (claims > 0) {
      try {
        await deps.refreshBalance?.()
      } catch (err) {
        logger.warn("[sipaClaims] balance refresh failed:", err)
      }
    }
    for (const write of recordWrites) {
      try {
        await write()
      } catch (err) {
        result.failed += 1
        logger.warn("[sipaClaims] recording a sweep failed (reconciled next sync):", err)
      }
    }
  } finally {
    end?.()
  }

  // TODO: a deposit whose discovery event never arrives (resolver or broadcaster failed) has no
  // record here and no exit; its address and salt are both unknown to the wallet. Recovering it
  // means brute-forcing the resolver salt over (day, nonce) with the user's key and the registry's
  // resolver key, deriving each SIPA address, and checking its L1 balance.

  return result
}

/** Stamp the funder + funding tx off the first observed `Transfer(to = sipa)` and fire the contact hook. */
async function attributeFunding(
  deps: SipaDepositSyncDeps,
  sipaAddress: Address,
  fallback: Omit<SIPADepositRecord, "sipaAddress" | "phase">,
  fromBlock: bigint | undefined,
  run: SyncRunContext,
  reads: ScanReads,
): Promise<bigint | undefined> {
  const batched = reads.fundings?.map((byToken) => byToken.get(sipaAddress.toLowerCase()))
  const found = batched?.every((transfers) => transfers !== undefined)
    ? firstFunding(batched as SipaFundingTransfer[][], run.fundingTokens)
    : await readFirstFunding(deps.publicClient, sipaAddress, run.fundingTokens, fromBlock, run.head)
  if (!found) return undefined
  const { transfer: first, token: fundedWith } = found

  const current = deps.store.get(sipaAddress)
  const patch: Partial<SIPADepositRecord> = {
    fundingTxHash: first.txHash,
    fundingFromAddress: first.from,
    fundingTokenSymbol: fundedWith.symbol,
  }
  // Attribution can arrive after a sweep or claim; keep the credited token in that case.
  if (current?.netAmount == null) {
    patch.tokenAddress = fundedWith.address
    patch.tokenSymbol = fundedWith.symbol
    patch.tokenDecimals = fundedWith.decimals
  }
  // Backfill the display identity so third-party deposits thread under a
  // contact; a connected-session identity is never overwritten.
  if (!current?.walletAddress) patch.walletAddress = first.from
  await deps.store.upsert(sipaAddress, { phase: current?.phase ?? "broadcast", ...patch }, fallback)

  if (deps.onFundingWalletDetected) {
    const sessionMatch = current?.walletAddress?.toLowerCase() === first.from.toLowerCase()
    await deps.onFundingWalletDetected({
      address: first.from,
      walletName: sessionMatch ? current?.walletName : undefined,
      walletImageUrl: sessionMatch ? current?.walletImageUrl : undefined,
      walletProvider: sessionMatch ? current?.walletProvider : undefined,
      lastUsedAt: Date.now(),
    })
  }
  return first.blockNumber
}

/** The intentHash of a record's synthesized event: no event was discovered, so it carries no intent. */
const NO_EVENT_INTENT = "0x0"

/**
 * Whether an event announces a deposit, and the hash its address commits to. A deposit commits to
 * the recipient, so its hash re-derives here. Any other hash is a registration or an upgrade's
 * metadata update, whose intent data only the event's sender holds.
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
const recordKinds = (record: SIPADepositRecord): IntentKind[] =>
  record.intent ? ["other"] : record.origin ? ["deposit"] : ["deposit", "other"]

const recordSeen = (record: SIPADepositRecord & { messageSecret: string }, keys: Set<string>) =>
  recordKinds(record).some((kind) => keys.has(pinKey(record.messageSecret, kind)))

async function eventKind(sipaEvent: SipaEvent, recipient: AztecAddress): Promise<IntentKind> {
  const commitment = await computeStealthRecipientHash(sipaEvent.sharedSecretSalt, recipient)
  return eventIntent(sipaEvent, commitment).deposit ? "deposit" : "other"
}

/**
 * A replayed registration record never swept as one. Before upgrades were told apart, an upgrade's
 * metadata-update SIPA was stored this way at its registration-derived address. A registration's
 * own sweep settles the question; stray funds sent to the address do not.
 */
function maybeMisfiled(record: SIPADepositRecord | null): record is SIPADepositRecord {
  return (
    !!record &&
    record.intent === "registration" &&
    !!record.replayed &&
    !record.sweepTxHash &&
    !record.inboxIndex &&
    !record.sweeps?.length
  )
}

function updateMetadataImplementation(tuple: OxideEnvTuple): EthAddress {
  const implementation = tuple.updateMetadataSIPAImplementation
  if (!implementation || /^0x0*$/i.test(implementation))
    throw new Error("oxide manifest lacks updateMetadataSIPAImplementation")
  return EthAddress.fromString(implementation)
}

/**
 * Which intent a non-deposit event announces. Only its sender holds the intent data, so the chain
 * decides: an upgrade's metadata SIPA emits a `Sweep` when its upgrade settles, and a clone holding
 * a registration's intent hash cannot. Anyone can deploy either candidate, so code alone decides
 * nothing; it only skips the log read for a candidate never deployed. Until that sweep, the event
 * reads as a registration.
 */
async function nonDepositIntent(
  deps: SipaDepositSyncDeps,
  run: SyncRunContext,
  predict: (implementation: EthAddress) => { toString(): string } | undefined,
): Promise<"registration" | "metadata"> {
  const upgrade = deps.tuple.updateMetadataSIPAImplementation
  if (!upgrade || /^0x0*$/i.test(upgrade)) return "registration"
  const candidate = predict(EthAddress.fromString(upgrade))?.toString() as Address | undefined
  if (!candidate) return "registration"
  const code = await deps.publicClient.getCode({ address: candidate })
  if (!code || code === "0x") return "registration"
  const sweeps = await readSweepEvents(
    deps.publicClient,
    candidate,
    await run.historyStart(),
    run.head,
  )
  return sweeps.length > 0 ? "metadata" : "registration"
}

/** A SIPA due a scan this run: what discovery found, carried into its scan. */
type DueScan = NonNullable<Awaited<ReturnType<typeof syncOneEvent>>>

/**
 * Reads batched across every due SIPA, keyed by lowercased SIPA. A batch that failed is undefined
 * and a SIPA it does not cover reads alone, so one bad batch costs requests, not deposits.
 */
interface ScanReads {
  sweeps?: Map<string, SipaSweepEvent[]>
  /** One map per `run.fundingTokens` entry, in order. */
  fundings?: Map<string, SipaFundingTransfer[]>[]
  recovered?: Map<string, SipaRecoveredEvent[]>
  /** Token balances plus ETH under the zero address. */
  balances?: Map<string, Map<string, bigint>>
}

/**
 * One chunked `getLogs` per event kind over every due SIPA, and one Multicall3 `eth_call` for their
 * balances. Balances and recoveries are read only for SIPAs with no sweep in their window: the only
 * ones whose scan reaches them.
 */
async function readDueScans(
  deps: SipaDepositSyncDeps,
  run: SyncRunContext,
  due: readonly DueScan[],
): Promise<ScanReads> {
  const soft = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read()
    } catch (err) {
      logger.warn("[sipaClaims] batched read failed, reading per SIPA:", err)
      return undefined
    }
  }
  const windows = due.map((d) => ({ sipa: d.sipaAddress, fromBlock: d.fromBlock }))
  const unattributed = due
    .filter((d) => !d.record?.fundingFromAddress)
    .map((d) => ({ sipa: d.sipaAddress, fromBlock: d.fromBlock }))
  const [sweeps, fundings] = await Promise.all([
    soft(() => readSweepEventsMany(deps.publicClient, windows, run.head)),
    soft(() =>
      Promise.all(
        run.fundingTokens.map((token) =>
          readFundingTransfersMany(deps.publicClient, token.address, unattributed, run.head),
        ),
      ),
    ),
  ])
  const idle = sweeps ? windows.filter((w) => !sweeps.get(w.sipa.toLowerCase())?.length) : []
  const [recovered, balances] = await Promise.all([
    soft(() => readRecoveredEventsMany(deps.publicClient, idle, run.head)),
    soft(() =>
      readSipaBalancesMany(
        deps.publicClient,
        idle.map((w) => w.sipa),
        run.fundingTokens.map((token) => token.address),
      ),
    ),
  ])
  return { sweeps, fundings, recovered, balances }
}

/** Values shared by every event in one run: the scan's upper bound, its clock, its fee floors. */
interface SyncRunContext {
  head: bigint
  now: number
  feeFor: (implementation: EthAddress) => Promise<bigint>
  registrationImplementation: () => Promise<EthAddress>
  /** `OxidePortal.FPC_FUNDING_CUT` taken off every credited deposit. */
  fpcFundingCut: () => Promise<bigint>
  /** Non-empty; `[deps.token]` when the caller passed no wider list. */
  fundingTokens: SipaFundingToken[]
  /** `deps.historyStartBlock`, read at most once per run; undefined when unavailable. */
  historyStart: () => Promise<bigint | undefined>
  /**
   * Queues a sweep's record write. The queue runs in order after the pass's one balance read, so a
   * claim reads `claimed` only once the balance holds it and never overwrites a later sweep's state.
   */
  record: (write: () => Promise<void>) => void
  /** `record`, for a write that marks a claim: the balance is read before the queue runs. */
  claimed: (write: () => Promise<void>) => void
  /** A sweep's L1→L2 message key, read at most once per run. */
  messageKey: (sweep: Pick<SipaSweepEvent, "txHash" | "index">) => Promise<unknown>
  /** Whether an L1→L2 message is ready to claim, read at most once per run. */
  messageReady: (messageKey: unknown) => Promise<boolean>
}

/**
 * The pass's L1 client: a receipt or a block is read once however many steps need it. A failed
 * read is dropped so the next caller retries it.
 */
export function passClient(client: PublicClient): PublicClient {
  const receipts = new Map<string, ReturnType<PublicClient["getTransactionReceipt"]>>()
  const blocks = new Map<bigint, ReturnType<PublicClient["getBlock"]>>()
  const once = <K, V>(cache: Map<K, Promise<V>>, key: K, read: () => Promise<V>) => {
    const cached = cache.get(key)
    if (cached) return cached
    const pending = read()
    cache.set(key, pending)
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key)
    })
    return pending
  }
  return {
    ...client,
    getTransactionReceipt: (args) =>
      once(receipts, args.hash.toLowerCase(), () => client.getTransactionReceipt(args)),
    getBlock: ((args) =>
      args?.blockNumber === undefined || args.includeTransactions
        ? client.getBlock(args)
        : once(blocks, args.blockNumber, () => client.getBlock(args))) as PublicClient["getBlock"],
  }
}

/**
 * Starts every read a due SIPA's claim tail makes before the first claim: its funding and sweep
 * blocks, each sweep's receipt and, from it, the message's readiness. They batch into a few round
 * trips, and the tail then finds them in the pass's caches. A failed read is left to the tail.
 */
async function prefetchSweepReads(
  deps: SipaDepositSyncDeps,
  run: SyncRunContext,
  due: readonly DueScan[],
  reads: ScanReads,
): Promise<void> {
  const soft = (read: () => unknown) =>
    Promise.resolve()
      .then(read)
      .catch(() => undefined)
  await Promise.all(
    due.flatMap((scan) => {
      const key = scan.sipaAddress.toLowerCase()
      const claimed = new Set(scan.record?.claimedInboxIndexes ?? [])
      const firstFunding = reads.fundings
        ?.map((byToken) => byToken.get(key)?.[0]?.blockNumber)
        .filter((block): block is bigint => block !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]
      const sweeps = (reads.sweeps?.get(key) ?? []).filter((s) => !claimed.has(s.index.toString()))
      return [
        ...(firstFunding === undefined
          ? []
          : [soft(() => readBlockTimeMs(deps.publicClient, firstFunding))]),
        ...sweeps.flatMap((sweep) => [
          soft(() => readBlockTimeMs(deps.publicClient, sweep.blockNumber)),
          soft(async () => {
            const messageKey = await run.messageKey(sweep)
            if (messageKey) await run.messageReady(messageKey)
          }),
        ]),
      ]
    }),
  )
}

/** `local` is the recorded address of a self-initiated SIPA; it overrides the event's derivation. */
async function syncOneEvent(
  deps: SipaDepositSyncDeps,
  sipaEvent: SipaEvent,
  depositImplementation: EthAddress,
  result: SipaDepositSyncResult,
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
  if (accountProtocol && (!deps.recoveryAccount || !tuple.accountFactory))
    throw new Error("SIPA discovery needs the recovery account")
  const recoveryCommitment = accountProtocol
    ? deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(deps.recoveryAccount!))
    : undefined
  const predict = (implementation: EthAddress) => {
    if (!fromEvent) return undefined
    const inputs = {
      sipaFactory: EthAddress.fromString(tuple.sipaFactory!),
      implementation,
      intentHash: fromEvent.intentHash,
      rollupVersion: BigInt(tuple.rollupVersion),
      resweepable: sipaEvent.resweepable,
    }
    return accountProtocol
      ? computeAccountSIPAAddress({ ...inputs, recoveryCommitment: recoveryCommitment! })
      : computeSIPAAddress({ ...inputs, recoveryAddress })
  }
  // The intent comes from the record when it holds one, else the event. A record that may be a
  // misfiled upgrade is checked again, at its scan cadence, until it is swept. Proven misfiled, an empty one moves to the
  // upgrade's address; one holding stray funds stays to track them, and the upgrade gets its own.
  const pinned = local ? deps.store.get(local) : null
  let intent = pinned?.intent
  let misfiled: Address | undefined
  let strayHolder = false
  const recheck = maybeMisfiled(pinned) && scanDue(pinned, run.now)
  if (fromEvent && !fromEvent.deposit && (!intent || recheck)) {
    const resolved = await nonDepositIntent(deps, run, predict)
    if (resolved === "metadata" && recheck && !isUnfundedSipaDeposit(pinned!)) strayHolder = true
    else {
      if (recheck && resolved !== intent) misfiled = local
      intent = resolved
    }
  }
  const implementation =
    intent === "registration"
      ? await run.registrationImplementation()
      : intent === "metadata"
      ? updateMetadataImplementation(tuple)
      : depositImplementation
  const predicted = predict(implementation)
  const sipaAddress = (misfiled ? undefined : local) ?? (predicted?.toString() as Address)
  if (!sipaAddress) throw new Error("SIPA event has no address origin")
  const originFor = (implementation: EthAddress): SIPADepositRecord["origin"] => ({
    sipaFactory: tuple.sipaFactory! as Address,
    implementation: implementation.toString() as Address,
    intentHash: sipaEvent.intentHash,
    rollupVersion: tuple.rollupVersion,
    resweepable: sipaEvent.resweepable,
    ...(accountProtocol
      ? {
          protocol: "account" as const,
          accountFactory: tuple.accountFactory! as Address,
          recoveryAccount: deps.recoveryAccount!,
          recoveryCommitment: recoveryCommitment!.toString() as Hex,
        }
      : {
          protocol: "legacy-eoa" as const,
          recoveryAddress: recoveryAddress.toString() as Address,
        }),
  })
  const origin =
    predicted?.toString().toLowerCase() === sipaAddress.toLowerCase()
      ? originFor(implementation)
      : undefined
  result.discovered += 1

  const fallback: Omit<SIPADepositRecord, "sipaAddress" | "phase"> = {
    recipientL2Address: deps.recipient.toString(),
    messageSecret: sharedSecretSalt.toString(),
    recipientHash: recipientCommitment.toString(),
    recoveryAddress: accountProtocol ? "" : recoveryAddress.toString(),
    origin,
    l1ChainId: deps.l1ChainId,
    amount: "0",
    tokenSymbol: deps.token.symbol,
    startTime: Date.now(),
    tokenAddress: deps.token.address,
    ...(intent ? { intent } : {}),
  }
  const existing = deps.store.get(sipaAddress)
  // A record first seen this run (a fresh device replaying history) carries no real start time
  // until its funding or sweep block is read below.
  const discovered = !existing
  if (discovered) {
    await deps.store.upsert(sipaAddress, { phase: "broadcast", replayed: true }, fallback)
  } else {
    // Self-initiated records are created pre-discovery with empty derived
    // fields — backfill them so the deposit is enumerable. Monotonic: never
    // overwrite a non-empty value.
    const backfill: Partial<SIPADepositRecord> = {}
    if (!existing.messageSecret) backfill.messageSecret = fallback.messageSecret
    if (!existing.recipientHash) backfill.recipientHash = fallback.recipientHash
    if (!existing.recoveryAddress) backfill.recoveryAddress = fallback.recoveryAddress
    if (!existing.origin && origin) backfill.origin = origin
    if (intent && !existing.intent) backfill.intent = intent
    if (Object.keys(backfill).length > 0) {
      await deps.store.upsert(sipaAddress, { phase: existing.phase, ...backfill })
    }
  }

  if (misfiled) await deps.store.remove(misfiled)
  if (strayHolder) {
    const upgrade = updateMetadataImplementation(tuple)
    const address = predict(upgrade)!.toString() as Address
    if (!deps.store.get(address))
      await deps.store.upsert(
        address,
        { phase: "broadcast", replayed: true },
        { ...fallback, origin: originFor(upgrade), intent: "metadata" },
      )
  }

  const record = deps.store.get(sipaAddress)
  const phase = record?.phase ?? "broadcast"
  // Judged on the record as it stood before this pass wrote it: an event discovered now is due.
  if (isFastLane(existing, run.now)) {
    result.active += 1
  } else if (run.now - (record?.lastScanAt ?? 0) < SLOW_SCAN_INTERVAL_MS) {
    result.skipped += 1
    return
  }

  // Resume where the last scan stopped. A SIPA never scanned, or a replayed one still unfunded,
  // reads from the account's history start once. The reader chunks the range itself, so a cursor
  // far behind the head still reaches it in one tick. A record claimed before the ledger existed
  // reads from the start, whatever earlier scans covered, until every claimed sweep has its entry.
  const scannedThrough = record?.lastScannedBlock ? BigInt(record.lastScannedBlock) : undefined
  const fromStart =
    scannedThrough === undefined ||
    (!!record?.replayed && isUnfundedSipaDeposit(record) && !record.historyScanned) ||
    (!!record && unledgeredSweeps(record))
  const start = fromStart ? await run.historyStart() : undefined
  const fromBlock =
    start ??
    (scannedThrough === undefined
      ? undefined
      : bigMax(scannedThrough - SCAN_REORG_OVERLAP_BLOCKS, 0n))
  return {
    deps,
    result,
    run,
    sharedSecretSalt,
    sipaAddress,
    fallback,
    record,
    phase,
    intent,
    implementation,
    discovered,
    fromBlock,
    historyScanned: start !== undefined,
  }
}

/** The rest of a due SIPA's sync, once the batched reads land. */
async function scanOne(due: DueScan, reads: ScanReads): Promise<void> {
  const { deps, result, run, sharedSecretSalt, sipaAddress, fallback, record, phase } = due
  const { intent, implementation, discovered, fromBlock } = due
  const { tuple } = deps
  const sipaKey = sipaAddress.toLowerCase()

  // Funding attribution: the token-level sender of the first Transfer into the
  // SIPA — the data the retired gateway's Transfer scan used to report. Runs
  // alongside the sweep scan on its window and stops reading once stamped, so it
  // costs nothing at steady state.
  // Isolated: attribution is auxiliary and must not fail the claim path.
  const funding = record?.fundingFromAddress
    ? undefined
    : attributeFunding(deps, sipaAddress, fallback, fromBlock, run, reads).catch((err) => {
        logger.warn("[sipaClaims] funding attribution failed (will retry next sync):", err)
        return undefined
      })

  const [fundingBlock, windowSweeps] = await Promise.all([
    funding,
    reads.sweeps?.get(sipaKey) ??
      readSweepEvents(deps.publicClient as never, sipaAddress as never, fromBlock, run.head),
  ])

  // A sweep an earlier tick left unresolved sits below this window — the cursor moved past it — so
  // it is re-read at its own block and merged back in, dedup'd against the window by inbox index.
  const sweeps = [...windowSweeps]
  const retryBlocks = Array.from(
    new Set(
      (record?.unresolvedSweepBlocks ?? [])
        .map(BigInt)
        .filter((block) => fromBlock !== undefined && block < fromBlock),
    ),
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const block of retryBlocks) {
    const missed = await readSweepEvents(
      deps.publicClient as never,
      sipaAddress as never,
      block,
      block,
    )
    for (const sweep of missed) {
      if (!sweeps.some((s) => s.index === sweep.index)) sweeps.push(sweep)
    }
  }
  sweeps.sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  )

  // A deposit swept before the wallet's first scan skips the funding probe entirely, so the sweep
  // writes are where its fee lands. Both reads are run-level immutables. Neither may fail the
  // write it decorates: the claim it follows has already landed on L2, and a throw here would
  // leave the record marked unclaimed until a later pass reconciles it.
  const feeBreakdown = async (): Promise<Partial<SIPADepositRecord>> => {
    const stored = deps.store.get(sipaAddress) ?? record
    if (stored?.fee != null && stored.fpcFundingCut != null) return {}
    const [sweepFee, cut] = await Promise.allSettled([
      run.feeFor(implementation),
      run.fpcFundingCut(),
    ])
    if (sweepFee.status !== "fulfilled" || cut.status !== "fulfilled") return {}
    return {
      fee: (bigMax(sweepFee.value, BigInt(stored?.registrationFee ?? 0)) + cut.value).toString(),
      fpcFundingCut: cut.value.toString(),
    }
  }

  // Stamps a fee a failed read lost, so the deposit can show its net. The fee is the sweep fee
  // plus the cut and owes nothing to the log, so it retries on every tick until it lands — the
  // cursor moves past the sweep that would otherwise carry it.
  const repriceIfUnpriced = async () => {
    const stored = deps.store.get(sipaAddress) ?? record
    if (!stored || stored.fee != null) return
    const patch = await feeBreakdown()
    if (Object.keys(patch).length === 0) return
    await deps.store.upsert(sipaAddress, { ...patch, phase: stored.phase })
  }

  // Phases past a claim: every earlier one is priced by the funding probe below.
  const settledPhase = (deps.store.get(sipaAddress) ?? record)?.phase
  if (settledPhase === "claimed" || settledPhase === "pendingClaim") await repriceIfUnpriced()

  // A deposit is dated by its L1 funding transfer; a replayed one with none read, by its sweep.
  const datedBy = fundingBlock ?? (discovered ? sweeps[0]?.blockNumber : undefined)
  const startTime =
    datedBy === undefined ? undefined : await readBlockTimeMs(deps.publicClient, datedBy)
  if (startTime !== undefined) {
    const current = deps.store.get(sipaAddress)
    await deps.store.upsert(sipaAddress, { phase: current?.phase ?? phase, startTime }, fallback)
  }

  if (sweeps.length === 0) {
    // An event means the resolver broadcast, so a sweep should follow within
    // moments — a persistent zero here is the derivation-mismatch signature
    // (derived address ≠ the funded SIPA) or a stuck relayer. Once a sweep has
    // been claimed off this SIPA an empty window is just the steady state.
    if (!record?.claimedInboxIndexes?.length) {
      logger.log(
        `[sipaClaims] event → ${sipaAddress.slice(
          0,
          10,
        )}… has no sweeps on L1 yet (sweep in flight, or derived address mismatch)`,
      )
    }
    // Both halves of the floor at once, and settled: an RPC failure on either must not cost the
    // event its funding and sweep reads.
    const [feeRead, cutRead] = await Promise.allSettled([
      run.feeFor(implementation),
      run.fpcFundingCut(),
    ])
    const priced = feeRead.status === "fulfilled" && cutRead.status === "fulfilled"
    const cut = cutRead.status === "fulfilled" ? cutRead.value : 0n
    // A registration SIPA routes the schedule fee, which is at least the implementation's own.
    const fee = bigMax(
      feeRead.status === "fulfilled" ? feeRead.value : 0n,
      BigInt(record?.registrationFee ?? 0),
    )
    const answer =
      intent === "registration" ? deps.registrationScheduleFor?.(sipaAddress) : undefined
    // No schedule can sweep this address, so its balance is the user's to recover whatever the
    // floor reads say.
    const unsweepable = answer === "unsweepable"
    const schedule = answer === "unsweepable" ? undefined : answer
    // The floor cannot be priced: an unread immutable would floor it at zero and make dust look
    // sweepable, or the registration's schedule is not in hand. The balance is recorded and the
    // phase held for a pass that can price it.
    const undecided = !priced || schedule === null
    const accepted = (balance: bigint) =>
      !unsweepable && (!schedule || balance >= registrationFloor(schedule, cut))
    // `sweepable` covers the per-transaction window alone. The portal meters a global rate-limited
    // cap besides, which this sync does not read (`createSipaProcessingObserver` explains it), so a
    // balance inside the window can still be refused.
    const { token: fundedWith, status: funding } = await readSipaFunding(deps.publicClient, {
      sipa: sipaAddress,
      feeToken: deps.token,
      fundingTokens: run.fundingTokens,
      fee,
      fpcFundingCut: cut,
      accepted,
      decided: !undecided,
      balances: reads.balances?.get(sipaKey),
    })
    // Capture the gross funding + fee here — the third-party flow has no hook
    // to stamp them, and this is the only point both are in hand before a
    // sweep overwrites `amount` with the net. An unpriced pass writes neither, and the UI shows
    // the gross until a later pass reads the fee.
    const funded = {
      amount: formatUnits(funding.balance, fundedWith.decimals),
      ...(priced ? { fee: (fee + cut).toString(), fpcFundingCut: cut.toString() } : {}),
      tokenAddress: fundedWith.address,
      tokenSymbol: fundedWith.symbol,
      tokenDecimals: fundedWith.decimals,
      fundingTokenSymbol: fundedWith.symbol,
    }
    // Nothing to re-read: a listed sweep the reader returned no more is dropped here.
    const scanned = {
      lastScannedBlock: run.head.toString(),
      unresolvedSweepBlocks: [] as string[],
      lastScanAt: run.now,
      ...(due.historyScanned ? { historyScanned: true } : {}),
    }
    const before = deps.store.get(sipaAddress) ?? record
    const paidAgain = funding.balance > 0n && !!before && claimedBefore(before)
    const resweepable = (before?.origin ?? fallback.origin)?.resweepable !== false
    if (unsweepable && funding.balance > 0n) {
      // recoverERC20 is the only exit and it owes nothing to the fee reads, so this outranks an
      // unpriced pass — holding here would pin the record short of every recovery entry point.
      await deps.store.upsert(
        sipaAddress,
        { phase: "recoverable", ...funded, ...scanned },
        fallback,
      )
      result.recoverable += 1
    } else if (undecided && funding.balance > 0n) {
      await deps.store.upsert(sipaAddress, { phase, ...funded, ...scanned }, fallback)
    } else if (funding.balance > 0n && (!funding.sweepable || (paidAgain && !resweepable))) {
      // Outside the sweep window — the balance is at or below the sweep fee plus the portal's
      // funding cut, or what clears both exceeds the per-transaction cap — or a second payment to
      // an address that refuses a second sweep. No sweep moves it.
      await deps.store.upsert(
        sipaAddress,
        { phase: "recoverable", ...funded, ...scanned },
        fallback,
      )
      result.recoverable += 1
    } else if (paidAgain) {
      // Publish first: the record keeps its claim until then, so a failed publish retries next scan.
      try {
        await deps.onSweptAddressFunded?.(sipaAddress)
      } catch (err) {
        logger.warn(`[sipaClaims] ${sipaAddress} republish failed, retrying next scan:`, err)
        return
      }
      // The record now tracks the new payment: the stuck clock starts now, with no sweep yet.
      await deps.store.upsert(
        sipaAddress,
        {
          phase: "sweeping",
          ...funded,
          ...scanned,
          startTime: run.now,
          endTime: undefined,
          netAmount: undefined,
          sweepTxHash: undefined,
          claimTxHash: undefined,
          reorgEpoch: before?.reorgEpoch,
        },
        fallback,
      )
    } else if (funding.balance > 0n) {
      await deps.store.upsert(sipaAddress, { phase: "sweeping", ...funded, ...scanned }, fallback)
    } else {
      // No sweep moves ETH, so any at a never-swept address is the user's to recover. The sweep
      // window is only the recent blocks, so a claimed deposit reads as unswept here too. A failed
      // read throws: falling through would heal a `recoverable` ETH record to `recovered`.
      const stored = deps.store.get(sipaAddress) ?? record
      const swept =
        !!stored?.sweepTxHash || !!stored?.inboxIndex || !!stored?.claimedInboxIndexes?.length
      const eth = swept
        ? 0n
        : reads.balances?.get(sipaKey)?.get(NATIVE_ETH.address) ??
          (await deps.publicClient.getBalance({ address: sipaAddress }))
      if (eth > 0n) {
        await deps.store.upsert(
          sipaAddress,
          {
            phase: "recoverable",
            amount: formatUnits(eth, NATIVE_ETH.decimals),
            // A token fee read on an earlier pass would price the ETH.
            fee: undefined,
            fpcFundingCut: undefined,
            netAmount: undefined,
            tokenAddress: NATIVE_ETH.address,
            tokenSymbol: NATIVE_ETH.symbol,
            tokenDecimals: NATIVE_ETH.decimals,
            ...scanned,
          },
          fallback,
        )
        result.recoverable += 1
        return
      }
      const recovery = (
        reads.recovered?.get(sipaKey) ??
        (await readRecoveredEvents(
          deps.publicClient as never,
          sipaAddress as never,
          fromBlock,
          run.head,
        ))
      ).at(-1)
      if (recovery) {
        await deps.store.upsert(
          sipaAddress,
          { phase: "recovered", recoveryTxHash: recovery.txHash, ...scanned },
          fallback,
        )
        return
      }
      // Re-read: two awaits sit between the phase snapshot and this write, and a concurrent
      // `runSipaRecovery` may have settled the record as `recovered` inside them. Echoing the
      // snapshot would undo it, and a zero-balance SIPA is scanned forever, so it never heals.
      const latest = deps.store.get(sipaAddress)
      const current = latest?.phase ?? phase
      // Only a recovery empties a SIPA without emitting a `Sweep`, so a `recoverable` one
      // now at zero was recovered — including by a submission whose receipt wait never returned.
      // The hash stamped at submission survives the merge; none is invented here.
      const healed = current === "recoverable" && !latest?.claimedInboxIndexes?.length
      await deps.store.upsert(
        sipaAddress,
        { phase: healed ? "recovered" : current, ...scanned },
        fallback,
      )
    }
    return
  }

  // Sweeps this tick could not resolve. Each is re-read at its own block on the next tick, so the
  // cursor advances to the head without losing them.
  const unresolved: string[] = []
  const leaveForRetry = (blockNumber: bigint) => {
    const key = blockNumber.toString()
    if (!unresolved.includes(key)) unresolved.push(key)
  }

  // Per-SWEEP isolation: one sweep's failure must not block the SIPA's other
  // sweeps (a re-used SIPA accumulates several), and a deposit the PXE
  // already holds — claimed before the store write landed — is reconciled
  // into the record instead of retried forever.
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
    const settledAt = discovered ? sweptAt : undefined
    // What the sweep took out of the SIPA: which token, since a re-used address can be funded again
    // in another one and attribution names only its first funding, and how much, every funding
    // transfer it settled. Read before anything is written: a failed read leaves the sweep for the
    // next tick, like the message-key read off the same receipt. One accepted token needs no read
    // for its name, so a failed read then only leaves the gross unknown.
    const readSwept = async (): Promise<
      { token: SipaFundingToken; gross?: bigint } | undefined
    > => {
      const read = readSweptFunding(deps.publicClient, sweep.txHash, sipaAddress, run.fundingTokens)
      const single = run.fundingTokens.length === 1 ? run.fundingTokens[0] : undefined
      if (!single) return read
      const found = await read.catch(() => undefined)
      return { token: single, gross: found?.gross }
    }
    let swept: { token: SipaFundingToken; gross?: bigint } | undefined
    const ledgerEntry = (): SIPASweep => ({
      inboxIndex: indexKey,
      sweepTxHash: sweep.txHash,
      netAmount: sweep.amount.toString(),
      ...(sweptAt === undefined ? {} : { settledAt: sweptAt }),
      ...(swept?.gross === undefined
        ? {}
        : {
            grossAmount: swept.gross.toString(),
            fundingTokenSymbol: swept.token.symbol,
            fundingTokenDecimals: swept.token.decimals,
          }),
    })

    // A sweep claimed before the ledger existed gets its entry from the reads a claim makes.
    // Isolated: the ledger only reports, and a failed read leaves it to the next scan from the start.
    if (claimed) {
      await repriceIfUnpriced()
      try {
        swept = await readSwept()
        const stored = deps.store.get(sipaAddress)
        await deps.store.upsert(sipaAddress, {
          phase: stored?.phase ?? phase,
          sweeps: withSweep(stored?.sweeps, ledgerEntry()),
          reorgEpoch: stored?.reorgEpoch,
        })
      } catch (err) {
        logger.warn(
          `[sipaClaims] sweep ${indexKey}: ledger read failed (will retry next sync):`,
          err,
        )
      }
      continue
    }

    const markClaimed = async () => {
      claimedIndexes.add(indexKey)
      const fees = await feeBreakdown()
      const entry = ledgerEntry()
      const fundingTokenSymbol = swept?.token.symbol
      run.claimed(async () => {
        const stored = deps.store.get(sipaAddress)
        await deps.store.upsert(sipaAddress, {
          phase: "claimed",
          ...(settledAt === undefined ? {} : { endTime: settledAt }),
          inboxIndex: indexKey,
          claimedInboxIndexes: Array.from(claimedIndexes),
          sweeps: withSweep(stored?.sweeps, entry),
          netAmount: sweep.amount.toString(),
          amount: formatUnits(sweep.amount, deps.token.decimals),
          // The sweep swapped-and-credited in `deps.token`, so the amounts are in its units; the
          // token the funder sent is `fundingTokenSymbol`.
          tokenAddress: deps.token.address,
          tokenSymbol: deps.token.symbol,
          tokenDecimals: deps.token.decimals,
          sweepTxHash: sweep.txHash,
          ...fees,
          ...(fundingTokenSymbol ? { fundingTokenSymbol } : {}),
          // Thread the current epoch so a re-claim after a reorg demote isn't fenced as stale.
          reorgEpoch: stored?.reorgEpoch,
        })
      })
    }

    try {
      const messageKey = await run.messageKey(sweep)
      if (!messageKey) {
        throw new Error(
          `sweep tx ${sweep.txHash} has no portal Deposit event for inbox index ${indexKey}`,
        )
      }
      swept = await readSwept()

      if (!(await run.messageReady(messageKey))) {
        logger.log(
          `[sipaClaims] sweep ${indexKey}: message ${String(messageKey).slice(
            0,
            10,
          )}… not yet settled on L2 — will retry`,
        )
        const pending: Partial<SIPADepositRecord> = {
          inboxIndex: indexKey,
          netAmount: sweep.amount.toString(),
          amount: formatUnits(sweep.amount, deps.token.decimals),
          tokenAddress: deps.token.address,
          tokenSymbol: deps.token.symbol,
          tokenDecimals: deps.token.decimals,
          sweepTxHash: sweep.txHash,
          ...(await feeBreakdown()),
          ...(swept ? { fundingTokenSymbol: swept.token.symbol } : {}),
        }
        run.record(async () => {
          await deps.store.upsert(sipaAddress, { phase: "pendingClaim", ...pending })
        })
        result.pendingSettlement += 1
        leaveForRetry(sweep.blockNumber)
        continue
      }

      logger.log(`[sipaClaims] sweep ${indexKey}: settled — claiming into PXE…`)
      await deps.tokenService.claimSweptDeposit({
        inboxIndex: sweep.index,
        amount: sweep.amount,
        recipient: deps.recipient,
        sharedSecretSalt,
      })
      await markClaimed()
      result.claimed += 1
      logger.log(
        `[sipaClaims] sweep ${indexKey}: CLAIMED ${formatUnits(
          sweep.amount,
          deps.token.decimals,
        )} ${deps.token.symbol} — balance should reflect it`,
      )
    } catch (err) {
      if (isAlreadyClaimedDepositError(err)) {
        await markClaimed()
        result.reconciled += 1
        continue
      }
      result.failed += 1
      leaveForRetry(sweep.blockNumber)
      logger.warn(`[sipaClaims] sweep ${indexKey} failed (will retry next sync):`, err)
    }
  }

  await deps.store.upsert(sipaAddress, {
    phase: deps.store.get(sipaAddress)?.phase ?? phase,
    lastScannedBlock: run.head.toString(),
    unresolvedSweepBlocks: unresolved,
    lastScanAt: run.now,
    ...(due.historyScanned ? { historyScanned: true } : {}),
  })
}

/** A claimed sweep the ledger has no entry for: the record was claimed before the ledger existed. */
function unledgeredSweeps(record: SIPADepositRecord): boolean {
  const claimed =
    record.claimedInboxIndexes ??
    (record.phase === "claimed" && record.inboxIndex ? [record.inboxIndex] : [])
  return claimed.some((index) => !record.sweeps?.some((s) => s.inboxIndex === index))
}

/** The ledger with `entry` in place of any earlier entry for its sweep, in inbox order. */
function withSweep(sweeps: readonly SIPASweep[] | undefined, entry: SIPASweep): SIPASweep[] {
  return [...(sweeps ?? []).filter((s) => s.inboxIndex !== entry.inboxIndex), entry].sort((a, b) =>
    BigInt(a.inboxIndex) < BigInt(b.inboxIndex) ? -1 : 1,
  )
}

/**
 * Whether the funds now at this SIPA come after a claimed sweep. Besides `claimed`, a `sweeping`
 * record still stamped with its claimed sweep (settled time, claimed inbox index) qualifies: a
 * second payment once left the record so, with no stuck clock and no exit.
 */
function claimedBefore(
  record: Pick<SIPADepositRecord, "phase" | "endTime" | "inboxIndex" | "claimedInboxIndexes">,
): boolean {
  if (record.phase === "claimed") return true
  return (
    record.phase === "sweeping" &&
    !!record.endTime &&
    !!record.inboxIndex &&
    !!record.claimedInboxIndexes?.includes(record.inboxIndex)
  )
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}
