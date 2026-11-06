/**
 * The registration rail's background work: detection, seeding, refunds, the pending entry and rail
 * readiness.
 */
import {
  WalletError,
  bestEffort,
  currentRegistration,
  isRegistrationEscalated,
  loadRecords,
  readyValue,
  selectPendingEntry,
  selectSipaDeposit,
  task,
  valueOf,
  within,
  type IdentityView,
  type PendingRegistrationRecord,
  type ReadonlyStore,
  type RegistrationRecovery,
  type RegistrationStore,
  type Resource,
  type SipaDeposit,
  type SipaDeposits,
  type Store,
  type Task,
  type WalletIdentity,
} from "@obsidion/front-core"
import {
  waitForRegistrationMessage,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import type { Hex } from "viem"
import type { WebWalletConfig } from "../../config/env"
import { depositAdmitted, depositShown, expectsEarned } from "./admission"
import { readRegistrationStage } from "./openRegistration"
import { askedTotal, signedSchedule, signedWithoutSchedule, termsUnpriced } from "./registrationAsk"
import { healRegistrationDeposits, type RegistrationSeedStores } from "./registrationDepositSeed"
import type { RegistrationPricing } from "./registrationPricing"
import { registrationCandidates, seedRegistrationCandidates } from "./registrationRederive"
import { sponsoredRailPending, type RailPending } from "./sponsoredRailReadiness"
import { hasCustody, runDetectionTick, type WebDetectionDeps } from "./webRegistration"

const FAST_MS = 5_000
const SLOW_MS = 45_000

/**
 * The delay to the next detection tick: fast while the user waits on a deposit that landed, slow
 * for a record the cadence cannot help, and never under the tick's own floor.
 */
export function detectionCadence(record: PendingRegistrationRecord | null, nextMs: number): number {
  const fast = record !== null && hasCustody(record) && !isRegistrationEscalated(record)
  return Math.max(fast ? FAST_MS : SLOW_MS, nextMs)
}

/**
 * Carries the open registration to its close. No open record, no RPC: `reads` is demanded only
 * for one. A failed tick backs off.
 */
export function registrationDetection(
  registrations: Pick<RegistrationStore, "view">,
  reads: Resource<WebDetectionDeps>,
  tick?: typeof runDetectionTick,
): Task {
  return task("registrationDetection", {
    needs: {},
    every: SLOW_MS,
    whenHidden: "pause",
    backoff: { baseMs: 30_000, maxMs: 300_000 },
    async run({ signal }) {
      const records = await within(loadRecords(registrations.view), "registrations", { signal })
      if (!currentRegistration(records)) return
      if (reads.get().status === "failed") reads.retry()
      const deps = await readyValue(reads, signal)
      const ticked = (tick ?? runDetectionTick)(deps)
      const { nextMs } = await within(ticked, "registrationDetection", { signal })
      const open = currentRegistration(registrations.view.get().records)
      return { nextMs: detectionCadence(open, nextMs) }
    },
  })
}

/** Seeding runs once per session; it waits for the identity and the secret it derives under. */
const SEEDING = { every: "once", backoff: { baseMs: 60_000, maxMs: 3_600_000 } } as const

/** What a seeding task reads: the account's stores and key, and the page's config. */
type SeedingDeps = RegistrationSeedStores & { config: () => WebWalletConfig }

async function unlocked(own: RegistrationSeedStores, signal: AbortSignal) {
  const identity = own.identity.get().value
  const secret = await within(own.auth.getSecretKey(), "secret", { signal })
  if (!identity?.handle || !secret) throw new WalletError("wallet.notReady", "no name or secret")
  return { handle: identity.handle, address: identity.address as Hex, secret }
}

/**
 * Seeds every registration address this wallet's name can have, once its deposits replayed, so the
 * deposit sync watches the ones a fresh device has no record of.
 */
export function registrationRederive(
  needs: { wallet: Resource<ObsidionWallet> },
  own: SeedingDeps,
  candidates?: typeof registrationCandidates,
): Task {
  return task("registrationRederive", {
    ...SEEDING,
    needs,
    after: { firstBalance: true, depositsReplayed: true, movesReplayed: true },
    async run({ wallet, signal }) {
      const { handle, address, secret } = await unlocked(own, signal)
      const seeded = (candidates ?? registrationCandidates)(
        own.config(),
        wallet.networkId,
        secret,
        handle,
        address,
        own.sipaDeposits,
      ).then((c) => seedRegistrationCandidates(c))
      await within(seeded, "registrationRederive", { signal })
    },
  })
}

/** Seeds the claim inputs the account's registrations miss on this device. */
export function registrationHeal(
  needs: { wallet: Resource<ObsidionWallet> },
  own: SeedingDeps,
  heal?: typeof healRegistrationDeposits,
): Task {
  return task("registrationHeal", {
    ...SEEDING,
    needs,
    after: { firstBalance: true },
    async run({ wallet, signal }) {
      await unlocked(own, signal)
      const healed = (heal ?? healRegistrationDeposits)(own, own.config(), wallet.networkId)
      await within(healed, "registrationHeal", { signal })
    },
  })
}

/** Remembers each refund the chain settled off the account's registration addresses. */
export function registrationRefunds(own: {
  registrations: Pick<RegistrationStore, "view">
  sipaDeposits: Pick<SipaDeposits, "view">
  recovery: Pick<RegistrationRecovery, "reconcile">
}): Task {
  return task("registrationRefunds", {
    needs: {},
    every: 15_000,
    whenHidden: "pause",
    backoff: { baseMs: 15_000, maxMs: 300_000 },
    async run({ signal }) {
      const reconciled = Promise.all([
        loadRecords(own.registrations.view),
        loadRecords(own.sipaDeposits.view),
      ]).then(([records]) => Promise.all(records.map((r) => own.recovery.reconcile(r))))
      await within(reconciled, "registrationRefunds", { signal })
    },
  })
}

/** What the pending entry reads beside the record. */
export type EntryReads = Parameters<typeof readRegistrationStage>[0] &
  RegistrationPricing & { registrationRecovery: Pick<RegistrationRecovery, "refunded"> }

/** `selectPendingEntry` over the record's own facts. `linkFunds` says a link on this tab pays it. */
export function pendingEntry(
  own: EntryReads,
  record: PendingRegistrationRecord,
  nowMs: number,
  linkFunds: (record: PendingRegistrationRecord) => boolean,
) {
  const terms = record.terms ?? null
  const deposit = selectSipaDeposit(own.sipaDeposits.view.get(), record.sipaAddress)
  const earned = expectsEarned(record)
  // A stored record without a signed schedule is no quote, so it waives nothing on its own.
  const signedWaiver = terms?.fee !== undefined ? terms.feeWaived === true : undefined
  return selectPendingEntry({
    record,
    terms,
    stage: readRegistrationStage(own, record),
    paylinkStashed: linkFunds(record),
    depositAdmitted: depositAdmitted(record, deposit),
    refunded: own.registrationRecovery.refunded(record),
    depositSeen: depositShown(deposit),
    shown: depositShown(deposit),
    sweepFee: valueOf(own.sweepFee),
    expectedEarned: earned,
    feeWaived: !termsUnpriced(terms) && (signedWaiver ?? earned),
    signedQuote: signedSchedule(terms),
    // A stamped record carries deadline 0: no deadline known, which is not a lapsed one.
    claimDeadline: terms?.deadline || undefined,
    registrationsPaused: signedWithoutSchedule(terms) && valueOf(own.registrationSchedule) === null,
    earnedAsk: askedTotal("earned_tag"),
    nowMs,
  })
}

/**
 * Settles the open registration's tag once its address is the one it settles on, and so owes the
 * address's broadcast, whatever surface shows it. It writes the ledger only: the broadcasts task
 * proves, after the first balance and never over the user's own transaction.
 */
export function registrationEntry(
  own: EntryReads & {
    registrations: Pick<RegistrationStore, "view">
    linkFunds(record: PendingRegistrationRecord): boolean
    confirmTag(record: PendingRegistrationRecord): Promise<void>
  },
): Task {
  return task("registrationEntry", {
    needs: {},
    every: 5_000,
    whenHidden: "pause",
    backoff: { baseMs: 5_000, maxMs: 60_000 },
    async run({ signal }) {
      const records = await within(loadRecords(own.registrations.view), "registrations", { signal })
      const record = currentRegistration(records)
      if (!record || record.tagConfirmed === true) return
      // Only an earned tag's refund reads the sweep fee; only an unsigned quote reads the schedule.
      const prices: Resource<unknown>[] = []
      if (expectsEarned(record)) prices.push(own.sweepFee)
      if (signedWithoutSchedule(record.terms)) prices.push(own.registrationSchedule)
      await Promise.all(prices.map((r) => readyValue(r, signal)))
      if (!pendingEntry(own, record, Date.now(), own.linkFunds).settles) return
      await within(own.confirmTag(record), "registrationEntry", { signal })
    },
  })
}

/** The newest record when confirmed, funded or admitted; a recovery close names another tag. */
export function settledRegistration(
  records: readonly PendingRegistrationRecord[],
  deposits: readonly SipaDeposit[],
): PendingRegistrationRecord | null {
  const newest = records.reduce<PendingRegistrationRecord | null>(
    (a, r) => (!a || r.startTime > a.startTime ? r : a),
    null,
  )
  if (!newest || newest.notice?.recovery) return null
  const deposit = selectSipaDeposit({ records: deposits }, newest.sipaAddress)
  const settled = newest.phase === "confirmed" || newest.phase === "funded"
  return settled || depositAdmitted(newest, deposit) ? newest : null
}

/**
 * Enters the wallet on a settled registration: the identity names its tag, and the screens move
 * on from it. A signed-out session keeps no key, so it enters nothing.
 */
export function registrationIdentity(own: {
  registrations: Pick<RegistrationStore, "view">
  sipaDeposits: Pick<SipaDeposits, "view">
  identity: ReadonlyStore<IdentityView>
  signedIn(): boolean
  save(identity: WalletIdentity): Promise<void>
}): Task {
  return task("registrationIdentity", {
    needs: {},
    every: 5_000,
    whenHidden: "pause",
    backoff: { baseMs: 5_000, maxMs: 60_000 },
    async run({ signal }) {
      const { registrations, sipaDeposits } = own
      const read = Promise.all([loadRecords(registrations.view), loadRecords(sipaDeposits.view)])
      const record = settledRegistration(...(await within(read, "registrations", { signal })))
      const identity = own.identity.get()
      if (!record || !identity.loaded || identity.failed || !own.signedIn()) return
      if (identity.value?.handle === record.tag) return
      const saved = own.save({
        handle: record.tag,
        address: record.l2Address,
        claimedAt: Date.now(),
        ...(record.phase === "confirmed" ? {} : { pending: true }),
      })
      await within(saved, "registrationIdentity", { signal })
    },
  })
}

const RAIL_RECHECK_MS = 12_000

/**
 * The one reader of whether the account can ride the sponsored rail: the route gate and the upgrade
 * read `railPending`. Asked again while pending, so a held screen opens on its own; a message the
 * rollup has yet to import is waited on through the node.
 */
export function sponsoredRail(
  needs: {
    wallet: Resource<ObsidionWallet>
    account: Resource<ObsidionAccount>
    contractService: Resource<ContractService>
  },
  railPending: Store<RailPending>,
  rail?: { read: typeof sponsoredRailPending; imported: typeof waitForRegistrationMessage },
): Task {
  return task("sponsoredRail", {
    needs,
    every: RAIL_RECHECK_MS,
    async run({ wallet, account, contractService, signal }) {
      if (railPending.get() === false) return
      const read = (rail?.read ?? sponsoredRailPending)({ wallet, account, contractService })
      const waiting = await within(read, "sponsoredRail", { signal })
      railPending.set(waiting)
      if (!waiting || waiting.pending !== "import") return
      const wait = rail?.imported ?? waitForRegistrationMessage
      const timeoutSeconds = RAIL_RECHECK_MS / 1000
      const imported = wait(wallet.node, waiting.messageHash, { timeoutSeconds })
      await bestEffort("timeout", within(imported, "registration message", { signal }))
      return { nextMs: 0 }
    },
  })
}
