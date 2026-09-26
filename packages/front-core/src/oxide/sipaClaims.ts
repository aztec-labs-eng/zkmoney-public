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
 * Known SIPAs keep being scanned: a re-used/topped-up SIPA is re-swept but
 * never re-broadcast, so later `Sweep` events are visible only here; claims
 * dedup by inbox index. A funded SIPA whose balance is at or below the deposit
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
  readBlockTimeMs,
  readDepositFee,
  readDepositMessageKey,
  readFpcFundingCut,
  readFundingTransfers,
  readRecoveredEvents,
  readSipaFundingStatus,
  readSweepEvents,
  type SipaFundingStatus,
  type SipaFundingTransfer,
  type SipaEvent,
  type TokenService,
} from "@obsidion/sdk"
import { logger } from "src/utils/logger"

import { computeSIPAAddress as computeAccountSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { computeSIPAAddress } from "../core/services/deposits/sipa/sipaAddress"
import { depositSipaImplementation, registrationSipaImplementation } from "./sipaImplementations"
import {
  computeStealthRecipientHash,
  deriveRecoveryAddress,
  type SipaK1Point,
} from "../core/services/deposits/sipa/stealth"
import {
  isSettledSipaPhase,
  type SIPADepositRecord,
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
 * Slow-lane cadence. These SIPAs are still scanned — a re-used one is re-swept with no
 * new broadcast to announce it — just not every tick.
 */
const SLOW_SCAN_INTERVAL_MS = 5 * 60_000

/**
 * Whether `record`'s next event is imminent enough to spend a scan on this tick.
 * A missing record is an event discovered just now, which always is. A replayed one is
 * history replayed onto this device, so nothing is due on it either.
 */
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

/** An L1 ERC-20 a SIPA can be funded with. */
export interface SipaFundingToken {
  address: Address
  symbol: string
  decimals: number
}

/**
 * Balance multiplier normalizing a sent token into the fee token's denomination for the sweep
 * window check (mainnet stables swap ~1:1 into DAI). Identity when decimals already match.
 */
function feeScale(feeToken: SipaFundingToken, sent: SipaFundingToken): bigint {
  return 10n ** BigInt(Math.max(feeToken.decimals - sent.decimals, 0))
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
   * Syncs the wallet's chain view after a claim lands in the PXE; called once per claim without
   * blocking the pass, and the pass waits for the last call before ending its catch-up hold.
   */
  refreshBalance?: () => Promise<void>
  store: Pick<SIPADepositStore, "get" | "upsert" | "list">
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

/**
 * The contract's duplicate signals: `store_deposit` asserts
 * "deposit already stored" (capsule holds this inbox index) and "deposit
 * already spent" (nullifier exists — a prior session stored AND spent it).
 * "deposit already claimed" is the v4-era wording of the nullifier check.
 * All mean the deposit needs no further claim work — retrying forever would
 * wedge every later sweep on the SIPA.
 */
function isAlreadyClaimedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes("deposit already stored") ||
    message.includes("deposit already spent") ||
    message.includes("deposit already claimed")
  )
}

export async function syncSipaDeposits(deps: SipaDepositSyncDeps): Promise<SipaDepositSyncResult> {
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

  // A self-initiated SIPA's record was written at derivation, before its event existed. Index those
  // records by salt so an event and its record never disagree on the address. A registration
  // restarted at another fee reuses its salt at a new address, so one salt can pin several.
  const localBySalt = new Map<string, Address[]>()
  for (const r of deps.store.list()) {
    if (!r.messageSecret) continue
    const salt = r.messageSecret.toLowerCase()
    localBySalt.set(salt, [...(localBySalt.get(salt) ?? []), r.sipaAddress])
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
  const refreshes: Promise<void>[] = []
  const run: SyncRunContext = {
    head,
    now,
    feeFor,
    registrationImplementation,
    fpcFundingCut,
    fundingTokens,
    claimed: () => {
      const refresh = deps.refreshBalance?.()
      if (refresh) {
        refreshes.push(
          refresh.catch((err) => logger.warn("[sipaClaims] balance refresh failed:", err)),
        )
      }
    },
  }

  const replaying = events.some(
    (n) => !localBySalt.has(n.sharedSecretSalt.toString().toLowerCase()),
  )
  // A pass that discovers events with no local record is replaying history onto this device, so it
  // holds the balance and activity placeholders until its claims have refreshed the chain view.
  // Otherwise it only joins a catch-up already in progress.
  const end =
    replaying || globalEventEmitter.isSyncCatchingUp()
      ? globalEventEmitter.beginSyncCatchUp()
      : undefined
  try {
    for (const event of events) {
      const secretHex = event.sharedSecretSalt.toString()
      if (seen.has(secretHex)) continue
      seen.add(secretHex)
      const pins = localBySalt.get(secretHex.toLowerCase()) ?? [undefined]
      for (const pin of pins) {
        try {
          await syncOneEvent(deps, event, depositImplementation, result, run, pin)
        } catch (err) {
          result.failed += 1
          logger.warn("[sipaClaims] event sync failed (will retry next sync):", err)
        }
      }
    }

    // Records are the authoritative list of self-initiated SIPAs, so one whose event is absent
    // (discovery raced the broadcast, PXE reset) still syncs — synthesized into the same pipeline,
    // pinned to its recorded address.
    for (const r of deps.store.list()) {
      if (!r.messageSecret || isSettledSipaPhase(r.phase)) continue
      if (r.recipientL2Address?.toLowerCase() !== deps.recipient.toString().toLowerCase()) continue
      if (seen.has(r.messageSecret.toLowerCase())) continue
      try {
        const pseudo: SipaEvent = {
          sharedSecretSalt: Fr.fromString(r.messageSecret),
          resweepable: false,
          intentHash: NO_EVENT_INTENT,
        }
        await syncOneEvent(deps, pseudo, depositImplementation, result, run, r.sipaAddress)
      } catch (err) {
        result.failed += 1
        logger.warn("[sipaClaims] record sync failed (will retry next sync):", err)
      }
    }
  } finally {
    await Promise.all(refreshes)
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
  toBlock: bigint,
  fundingTokens: SipaFundingToken[],
): Promise<bigint | undefined> {
  // Earliest transfer across every accepted funding token — a SIPA is single-use, so the first
  // transfer in is the deposit whatever token carried it.
  const perToken = await Promise.all(
    fundingTokens.map((fundingToken) =>
      readFundingTransfers(
        deps.publicClient as never,
        fundingToken.address as never,
        sipaAddress as never,
        fromBlock,
        toBlock,
      ),
    ),
  )
  let first: SipaFundingTransfer | undefined
  let fundedWith: SipaFundingToken | undefined
  // List order breaks a tie on block number.
  for (let i = 0; i < perToken.length; i++) {
    const candidate = perToken[i][0]
    if (candidate && (!first || candidate.blockNumber < first.blockNumber)) {
      first = candidate
      fundedWith = fundingTokens[i]
    }
  }
  if (!first || !fundedWith) return undefined

  const current = deps.store.get(sipaAddress)
  const patch: Partial<SIPADepositRecord> = {
    fundingTxHash: first.txHash,
    fundingFromAddress: first.from,
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
 * The intent an event announces. A deposit commits to the recipient, so its hash re-derives here;
 * any other hash is a registration — the only other intent the wallet announces to itself —
 * and its address commits to registrationData only the event carries.
 */
function eventIntent(
  sipaEvent: SipaEvent,
  recipientCommitment: Fr,
): { intent?: SIPADepositRecord["intent"]; intentHash: Buffer } {
  const deposit = keccak256(recipientCommitment.toBuffer())
  const carried = Buffer.from(sipaEvent.intentHash.slice(2).padStart(64, "0"), "hex")
  return carried.equals(deposit)
    ? { intentHash: deposit }
    : { intent: "registration", intentHash: carried }
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
  /** Called once per claim; starts a chain-view refresh the pass waits for at the end. */
  claimed: () => void
}

/** `local` is the recorded address of a self-initiated SIPA; it overrides the event's derivation. */
async function syncOneEvent(
  deps: SipaDepositSyncDeps,
  sipaEvent: SipaEvent,
  depositImplementation: EthAddress,
  result: SipaDepositSyncResult,
  run: SyncRunContext,
  local?: Address,
): Promise<void> {
  const { tuple } = deps
  const sharedSecretSalt = sipaEvent.sharedSecretSalt
  const recipientCommitment = await computeStealthRecipientHash(sharedSecretSalt, deps.recipient)
  const recoveryAddress = deriveRecoveryAddress(deps.stealthPublicKey, sharedSecretSalt)
  // The intent comes from the record when it holds one, else the event.
  const fromEvent =
    sipaEvent.intentHash === NO_EVENT_INTENT ? null : eventIntent(sipaEvent, recipientCommitment)
  const intent = (local && deps.store.get(local)?.intent) || fromEvent?.intent
  const implementation =
    intent === "registration" ? await run.registrationImplementation() : depositImplementation
  const addressInputs = {
    sipaFactory: EthAddress.fromString(tuple.sipaFactory!),
    implementation,
    intentHash: fromEvent?.intentHash,
    rollupVersion: BigInt(tuple.rollupVersion),
    resweepable: sipaEvent.resweepable,
  }
  const accountProtocol = tuple.sipaRecoveryProtocol === "account"
  if (accountProtocol && (!deps.recoveryAccount || !tuple.accountFactory))
    throw new Error("SIPA discovery needs the recovery account")
  const recoveryCommitment = accountProtocol
    ? deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(deps.recoveryAccount!))
    : undefined
  const predicted = addressInputs.intentHash
    ? accountProtocol
      ? computeAccountSIPAAddress({
          ...addressInputs,
          intentHash: addressInputs.intentHash,
          recoveryCommitment: recoveryCommitment!,
        })
      : computeSIPAAddress({
          ...addressInputs,
          intentHash: addressInputs.intentHash,
          recoveryAddress,
        })
    : undefined
  const sipaAddress = local ?? (predicted?.toString() as Address)
  if (!sipaAddress) throw new Error("SIPA event has no address origin")
  const origin =
    predicted?.toString().toLowerCase() === sipaAddress.toLowerCase()
      ? {
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
        }
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

  const record = deps.store.get(sipaAddress)
  const phase = record?.phase ?? "broadcast"
  // Judged on the record as it stood before this pass wrote it: an event discovered now is due.
  if (isFastLane(existing, run.now)) {
    result.active += 1
  } else if (run.now - (record?.lastScanAt ?? 0) < SLOW_SCAN_INTERVAL_MS) {
    result.skipped += 1
    return
  }

  // Resume where the last scan stopped; the full look-back runs only for a SIPA never scanned.
  // The reader chunks the range itself, so a cursor far behind the head still reaches it in one tick.
  const scannedThrough = record?.lastScannedBlock ? BigInt(record.lastScannedBlock) : undefined
  const fromBlock =
    scannedThrough === undefined
      ? undefined
      : bigMax(scannedThrough - SCAN_REORG_OVERLAP_BLOCKS, 0n)

  // Funding attribution: the token-level sender of the first Transfer into the
  // SIPA — the data the retired gateway's Transfer scan used to report. Runs
  // alongside the sweep scan on its window and stops reading once stamped, so it
  // costs one extra getLogs per unattributed SIPA and nothing at steady state.
  // Isolated: attribution is auxiliary and must not fail the claim path.
  const funding = record?.fundingFromAddress
    ? undefined
    : attributeFunding(deps, sipaAddress, fallback, fromBlock, run.head, run.fundingTokens).catch(
        (err) => {
          logger.warn("[sipaClaims] funding attribution failed (will retry next sync):", err)
          return undefined
        },
      )

  const [fundingBlock, windowSweeps] = await Promise.all([
    funding,
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

  if (discovered) {
    const block = fundingBlock ?? sweeps[0]?.blockNumber
    const startTime =
      block === undefined ? undefined : await readBlockTimeMs(deps.publicClient, block)
    if (startTime !== undefined) {
      const current = deps.store.get(sipaAddress)
      await deps.store.upsert(sipaAddress, { phase: current?.phase ?? phase, startTime }, fallback)
    }
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
    // cap besides, which nothing here reads, so a balance inside the window can still be refused.
    const classify = (status: SipaFundingStatus): SipaFundingStatus =>
      status.sweepable && !accepted(status.scaledBalance) ? { ...status, sweepable: false } : status
    // Prefer a sweepable token, otherwise the largest normalized balance for recovery.
    // Dust in an earlier token must not hide funding in another accepted token. An undecided pass
    // prices the floor at zero, so `sweepable` means nothing: every token is probed and the
    // largest balance wins.
    let fundedWith = deps.token
    let funding = classify(
      await readSipaFundingStatus(deps.publicClient as never, {
        sipa: sipaAddress as never,
        token: deps.token.address as never,
        implementation: implementation.toString() as never,
        fee,
        fpcFundingCut: cut,
      }),
    )
    for (const fundingToken of run.fundingTokens) {
      if (!undecided && funding.sweepable) break
      if (fundingToken.address.toLowerCase() === deps.token.address.toLowerCase()) continue
      const status = classify(
        await readSipaFundingStatus(deps.publicClient as never, {
          sipa: sipaAddress as never,
          token: fundingToken.address as never,
          implementation: implementation.toString() as never,
          fee,
          fpcFundingCut: cut,
          balanceScale: feeScale(deps.token, fundingToken),
        }),
      )
      if ((!undecided && status.sweepable) || status.scaledBalance > funding.scaledBalance) {
        funding = status
        fundedWith = fundingToken
      }
    }
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
    }
    // Nothing to re-read: a listed sweep the reader returned no more is dropped here.
    const scanned = {
      lastScannedBlock: run.head.toString(),
      unresolvedSweepBlocks: [] as string[],
      lastScanAt: run.now,
    }
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
    } else if (funding.balance > 0n && !funding.sweepable) {
      // Outside the sweep window — the balance is at or below the sweep fee plus the portal's
      // funding cut, or what clears both exceeds the per-transaction cap. No sweep moves it.
      await deps.store.upsert(
        sipaAddress,
        { phase: "recoverable", ...funded, ...scanned },
        fallback,
      )
      result.recoverable += 1
    } else if (funding.balance > 0n) {
      await deps.store.upsert(sipaAddress, { phase: "sweeping", ...funded, ...scanned }, fallback)
    } else {
      const recovery = (
        await readRecoveredEvents(
          deps.publicClient as never,
          sipaAddress as never,
          fromBlock,
          run.head,
        )
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
      // Only `recoverERC20` empties a SIPA without emitting a `Sweep`, so a `recoverable` one
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
    if (claimedIndexes.has(indexKey)) {
      await repriceIfUnpriced()
      continue
    }

    // A replayed deposit settles at its sweep block whether this device claims it or an earlier one
    // did; a deposit already on record settles when its claim lands.
    const settledAt = discovered
      ? await readBlockTimeMs(deps.publicClient, sweep.blockNumber)
      : undefined
    const markClaimed = async () => {
      claimedIndexes.add(indexKey)
      await deps.store.upsert(sipaAddress, {
        phase: "claimed",
        ...(settledAt === undefined ? {} : { endTime: settledAt }),
        inboxIndex: indexKey,
        claimedInboxIndexes: Array.from(claimedIndexes),
        netAmount: sweep.amount.toString(),
        amount: formatUnits(sweep.amount, deps.token.decimals),
        // The sweep swapped-and-credited in `deps.token`; a record funded with another token
        // (mainnet USDC/USDT) now holds that, and the net amount is in its units.
        tokenAddress: deps.token.address,
        tokenSymbol: deps.token.symbol,
        tokenDecimals: deps.token.decimals,
        sweepTxHash: sweep.txHash,
        ...(await feeBreakdown()),
        // Thread the current epoch so a re-claim after a reorg demote isn't fenced as stale.
        reorgEpoch: deps.store.get(sipaAddress)?.reorgEpoch,
      })
      run.claimed()
    }

    try {
      const messageKey = await readDepositMessageKey(
        deps.publicClient as never,
        tuple.portal as never,
        sweep.txHash as never,
        sweep.index,
      )
      if (!messageKey) {
        throw new Error(
          `sweep tx ${sweep.txHash} has no portal Deposit event for inbox index ${indexKey}`,
        )
      }

      if (!(await isSweepMessageReady(deps.node, messageKey as never))) {
        logger.log(
          `[sipaClaims] sweep ${indexKey}: message ${String(messageKey).slice(
            0,
            10,
          )}… not yet settled on L2 — will retry`,
        )
        await deps.store.upsert(sipaAddress, {
          phase: "pendingClaim",
          inboxIndex: indexKey,
          netAmount: sweep.amount.toString(),
          amount: formatUnits(sweep.amount, deps.token.decimals),
          tokenAddress: deps.token.address,
          tokenSymbol: deps.token.symbol,
          tokenDecimals: deps.token.decimals,
          sweepTxHash: sweep.txHash,
          ...(await feeBreakdown()),
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
      if (isAlreadyClaimedError(err)) {
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
  })
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}
