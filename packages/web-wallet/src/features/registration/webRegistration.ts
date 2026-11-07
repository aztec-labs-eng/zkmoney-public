/**
 * Web glue for the optimistic-registration machine: the detection tick over a session's stores,
 * the presentation gate that keeps an unconfirmed tag rendering as claiming-in-progress until a
 * confirmation write settles the identity, and the one-shot notice a lost name owes the user.
 * Detection needs no PXE, no unlock, and no credential — a read-only account-service client plus
 * public RPC.
 */
import {
  currentRegistration,
  latestFailedRegistration,
  latestRegistration,
  matchWireNameHash,
  createOxideL1Reader,
  createRegistrationDepositReader,
  isRegistrationEscalated,
  isTerminalRegistrationPhase,
  deploymentSipaRoute,
  registrationAt,
  registrationUiState,
  resumeOxideRegistration,
  stageIdentity,
  useStore,
  type NameClaimRecord,
  type OxideResume,
  type OxideResumeDeps,
  type PendingRegistrationRecord,
  type RegistrationClose,
  type RegistrationScheduleAnswer,
  type RegistrationStore,
  type ResumeOptions,
  type WalletIdentity,
} from "@obsidion/front-core"
import { OxideSipaIntent, readNameClaimLog } from "@obsidion/sdk"
import { scheduleSource, signedSchedule } from "./registrationTerms"
import type { Address, Hex, PublicClient } from "viem"

import {
  getOxideTuple,
  l1PublicClient,
  oxideEnvFor,
  requireTupleField,
} from "../../config/oxideTuple"
import { WalletError, bestEffort } from "@obsidion/core/errors"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { fireOnboardingEvent } from "../../lib/analytics"
import { useSession, type Session, type SessionCore, type SessionDeps } from "../../session/session"
import { rememberUsertag } from "../../platform/auth/WebPasskeyIdentityMap"
import { wallClock } from "../../lib/clock"
import type { SignupStash } from "./signupStash"

/** A session's registrations, as the reads below take them. */
export type Registrations = Pick<RegistrationStore, "view">

/**
 * The session's registrations. A session is handed out once they have loaded, so an unloaded
 * view is a read made too early.
 */
export function loadedRegistrations(
  registrations: Registrations,
): readonly PendingRegistrationRecord[] {
  const { records, loaded, failed } = registrations.view.get()
  if (!loaded && !failed) throw new WalletError("wallet.notReady", "registrations not loaded")
  return records
}

/**
 * The registrations a funds path routes on: records that cannot be read are unknown, never none,
 * so the path holds.
 */
export function knownRegistrations(
  registrations: Registrations,
): readonly PendingRegistrationRecord[] {
  if (registrations.view.get().failed)
    throw new WalletError("wallet.notReady", "registrations could not be read")
  return loadedRegistrations(registrations)
}

/**
 * The pending registration behind a rail-tracked SIPA, if this deposit funds a name claim. The
 * deposit rail's exit surface routes on this: a registration SIPA's create2 binds the registration
 * intent (registration implementation, non-resweepable), so only the registration sweep can ever
 * move it — the plain deposit sweep fails its address parity check by construction.
 */
export function registrationRecordForSipa(
  registrations: Registrations,
  sipaAddress: string,
): PendingRegistrationRecord | null {
  return registrationAt(knownRegistrations(registrations), sipaAddress)
}

/**
 * The schedule a registration SIPA's sweep is priced against, for the SIPA deposit lane. Only the
 * amounts the claim was signed on count, and only while they still name the fee the address
 * committed to, since one priced otherwise cannot register that address.
 *
 * Undefined for an address this wallet never registered, which the lane classifies as a plain
 * deposit. Unsweepable for a closed record, and for a live one whose terms moved off the committed
 * fee: neither can be registered at the fee its address commits to, so recovery is the only exit
 * left. Null only while a live record's terms are simply missing — the floor is this wallet's to
 * know, so the lane holds rather than classifying against a floor it does not have.
 */
export function registrationScheduleForSipa(
  registrations: Registrations,
  sipaAddress: string,
): RegistrationScheduleAnswer {
  const record = registrationRecordForSipa(registrations, sipaAddress)
  if (!record) return undefined
  if (isTerminalRegistrationPhase(record.phase)) return "unsweepable"
  const amounts = signedSchedule(record.terms)
  if (!amounts) return null
  if (amounts.fee !== BigInt(record.fee)) return "unsweepable"
  return amounts
}

// ── Detection deps + tick ──────────────────────────────────────────────────────

/** Maps an on-chain nameHash back to a locally-known plaintext tag (adoption gate). */
export async function resolveLocalTag(
  nameHash: Hex,
  config: WebWalletConfig,
  identity: WalletIdentity | null,
): Promise<string | null> {
  if (!identity) return null
  const tuple = await getOxideTuple(config)
  const ensDomain = requireTupleField(tuple, "ensDomain")
  return matchWireNameHash(identity.handle, ensDomain, nameHash)
}

/** The resume machine's deps plus the L1 client a confirmed tick reuses for the NameClaim cache. */
export interface WebDetectionDeps extends OxideResumeDeps {
  publicClient: PublicClient
  nameClaims: NameClaimCache
  /** The page's database, where the passkey's tag is remembered, and its device keys. */
  database: Session["database"]
  device: Session["device"]
  identity: Session["identity"]
  signup: DetectionStores["signup"]
}

/** Where a confirmed claim's on-chain artifact is cached. */
type NameClaimCache = Pick<Session["nameClaims"], "put">

/** The session stores a detection tick reads and writes; a forced tick also owes broadcasts. */
export type DetectionStores = Pick<
  SessionCore,
  "registrations" | "sipaDeposits" | "nameClaims" | "identity"
> &
  Pick<SessionDeps, "namespace" | "database" | "device"> & {
    oweRegistrationBroadcast?: OxideResumeDeps["oweBroadcast"]
    signup: Pick<SignupStash, "grantToken" | "clearGrant">
  }

export async function buildWebDetectionDeps(
  config: WebWalletConfig,
  own: DetectionStores,
  extras: Pick<OxideResumeDeps, "getSignDeps"> = {},
): Promise<WebDetectionDeps> {
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  const { registrations, sipaDeposits, identity } = own
  return {
    env,
    l1: createOxideL1Reader(publicClient),
    publicClient,
    deposits: createRegistrationDepositReader({
      publicClient,
      registrationRoute: deploymentSipaRoute(tuple, OxideSipaIntent.Registration),
      registry: requireTupleField(tuple, "registry") as `0x${string}`,
      // Resolved from the registry, not the manifest: an absent or stale pin makes front-core
      // fall back to the registry, whose controller-era build has no schedule immutables.
      registrationController: await scheduleSource(config, publicClient as never),
      store: sipaDeposits,
      // The record holds no bearer material; the saved terms carry the signed amounts. The record
      // names the tag those terms priced, which one device's shared account cannot.
      termsFor: (account: string) => {
        const record = latestRegistration(loadedRegistrations(registrations), account)
        const amounts = signedSchedule(record?.terms)
        return record && amounts && amounts.fee === BigInt(record.fee)
          ? { fee: amounts.fee, minDeposit: amounts.min }
          : undefined
      },
    }),
    registrations,
    close: (record, event) => closeRegistration(own, record, event),
    nameClaims: own.nameClaims,
    database: own.database,
    device: own.device,
    identity,
    signup: own.signup,
    resolveLocalTag: (nameHash) => resolveLocalTag(nameHash, config, identity.get().value),
    sweepSent: async (sipa, txHash) =>
      void (await sipaDeposits.apply(sipa, { type: "sweepSent", txHash })),
    oweBroadcast: own.oweRegistrationBroadcast,
    // Only the pending step's forced retry supplies the sign deps a spent-rail renewal needs.
    ...extras,
  }
}

/**
 * A close the Registry, the claim server or a moved derivation decided. A lost name retracts the
 * identity that presents it, in the same write: a lost name is never shown as owned.
 */
export async function closeRegistration(
  own: Pick<Session, "registrations" | "namespace" | "database" | "identity">,
  record: PendingRegistrationRecord,
  event: RegistrationClose,
): Promise<void> {
  const lost = event.type === "replaced" || event.outcome !== "confirmed"
  const { registrations, namespace, database, identity } = own
  await database.write(async (w) => {
    await registrations.apply(record.sipaAddress, event, w.scoped(namespace.prefix))
    if (lost && isIdentityRecord(identity.get().value, record))
      stageIdentity(w, namespace.prefix, null)
  })
}

/** One detection tick and what a confirmation owes. */
export async function runDetectionTick(
  deps: WebDetectionDeps,
  opts: ResumeOptions = {},
): Promise<OxideResume> {
  // The tick may close the record it runs on, which `currentRegistration` then no longer finds.
  const records = loadedRegistrations(deps.registrations)
  const selected = opts.expectedRecord
    ? latestRegistration(records, opts.expectedRecord.account)
    : currentRegistration(records)
  const resume = await resumeOxideRegistration(deps, opts)
  const record =
    selected && registrationAt(loadedRegistrations(deps.registrations), selected.sipaAddress)
  if (resume.outcome === "confirmed" && record?.phase === "confirmed") {
    settleConfirmedTag(deps, record)
    applyConfirmedSideEffects(deps, record)
  }
  return resume
}

/**
 * What a confirmation owes beyond settling the identity: the funnel event and the NameClaim cache
 * the first sponsored batch subscribes with. Both are best-effort — identity settlement is
 * authoritative, and a missing cache entry costs only a recovery log scan at subscribe time.
 */
function applyConfirmedSideEffects(
  deps: WebDetectionDeps,
  record: PendingRegistrationRecord,
): void {
  // Deposit → confirmed comes from the durable record, so it survives the reload that a per-tab
  // analytics session does not. `fundedAt` is the closest custody marker in the deposit model.
  if (record.fundedAt !== undefined) {
    fireOnboardingEvent("onboarding_tag_claimed", {
      custody_to_confirmed_ms: Date.now() - record.fundedAt,
    })
  }
  void cacheNameClaimFromLog(deps.nameClaims, deps.publicClient, deps.env.registry, record).catch(
    warnCacheFailure,
  )
}

/** The subject of a cache write: which account to read the log from, and who to file it under. */
export interface ConfirmedClaimSubject {
  account: string
  tag: string
  l2Address: string
}

function warnCacheFailure(err: unknown): void {
  console.warn("[webRegistration] NameClaim cache write failed:", err)
}

/**
 * Cache the `NameClaimed` entry the Registry actually holds, keyed by L2 account, and return the
 * record (null when the Registry logged nothing for the account). Never the domain signer's
 * response: a reissued signature carries a different nonce/deadline than the one on chain, and
 * the cache's whole contract is that every entry is the on-chain artifact.
 */
export async function cacheNameClaimFromLog(
  nameClaims: NameClaimCache,
  publicClient: PublicClient,
  registry: Address,
  subject: ConfirmedClaimSubject,
): Promise<NameClaimRecord | null> {
  const log = await readNameClaimLog(publicClient, registry, subject.account as Address)
  if (!log) return null
  const record: NameClaimRecord = {
    address: subject.l2Address,
    handle: subject.tag,
    nameHash: log.nameHash,
    signature: log.signature,
    nonce: log.nonce,
    deadline: log.deadline,
  }
  await nameClaims.put(record)
  return record
}

/**
 * The same cache write for a session that saw confirmation itself — a precheck that found the name
 * already ours, or a sponsor 409 disambiguated to our own account. Fire-and-forget by construction:
 * a missing entry costs the first sponsored batch one log scan, so it must never sit in front of
 * the flow that produced it.
 */
export function cacheConfirmedNameClaim(
  nameClaims: NameClaimCache,
  config: WebWalletConfig,
  subject: ConfirmedClaimSubject,
): void {
  void (async () => {
    const tuple = await getOxideTuple(config)
    const registry = requireTupleField(tuple, "registry") as Address
    await cacheNameClaimFromLog(nameClaims, l1PublicClient(config), registry, subject)
  })().catch(warnCacheFailure)
}

/** The tag is confirmed: the session's passkey remembers it, and its name grant is spent. */
function settleConfirmedTag(
  {
    database,
    device,
    identity,
    signup,
  }: Pick<WebDetectionDeps, "database" | "device" | "identity" | "signup">,
  record: PendingRegistrationRecord,
): void {
  if (!isIdentityRecord(identity.get().value, record)) return
  const { credentialId } = device.get()
  if (credentialId) {
    void bestEffort(
      "unknown",
      rememberUsertag(database, getConfig().rpId, credentialId, record.tag),
    )
  }
  signup.clearGrant(record.tag)
}

// ── Live-record discovery ──────────────────────────────────────────────────────

/** The name is coming: an L1 deposit landed at the SIPA (funded) or the relayer already swept it. */
export function hasCustody(record: PendingRegistrationRecord): boolean {
  return record.fundedAt !== undefined || record.sweptAt !== undefined
}

/** The deposit left the address for the portal: only the registry read is still to come. */
export function registrationSwept(
  record: Pick<PendingRegistrationRecord, "sweptAt" | "sweepTxHash">,
): boolean {
  return record.sweptAt !== undefined || record.sweepTxHash !== undefined
}

// ── Tag presentation gate ──────────────────────────────────────────────────────

const isIdentityRecord = (
  identity: WalletIdentity | null,
  record: PendingRegistrationRecord,
): identity is WalletIdentity =>
  identity?.handle === record.tag &&
  identity.address.toLowerCase() === record.l2Address.toLowerCase()

/**
 * True while the identity must render as claiming-in-progress: its tag's record exists and is not
 * confirmed, or the records failed to load. A failed record keeps it true, so a name the chain
 * refused is never shown as owned. So does an unread recovery notice: `needs_recovery` closes the
 * record `confirmed`.
 */
export function isTagPresentationPending(
  registrations: Registrations,
  identity: WalletIdentity | null,
): boolean {
  // Records that failed to load are unknown, never none: the tag keeps rendering as claiming.
  if (identity?.handle && registrations.view.get().failed) return true
  const record = [...loadedRegistrations(registrations)]
    .sort((a, b) => b.startTime - a.startTime)
    .find((r) => isIdentityRecord(identity, r))
  if (!record) return false
  return record.phase !== "confirmed" || recoveryOwed(record)
}

/** The recovery notice is still the user's to read. */
const recoveryOwed = (record: PendingRegistrationRecord) =>
  record.notice?.recovery === true && record.notice.acknowledged !== true

/** Re-renders on the records of the session the view runs in, and reads them. */
function useRegistrationReads(): Registrations {
  const session = useSession()
  useStore(session.registrations.view)
  return session.registrations
}

/** Render-level gate for home/deposit tag surfaces; also gates DepositScreen's mount effects. */
export function useTagPresentationPending(): boolean {
  const registrations = useRegistrationReads()
  return isTagPresentationPending(registrations, useStore(useSession().identity).value)
}

/**
 * True once the open record is past the silent-retry bounds. Background ticks are detection-only
 * from here, so the claiming copy must stop reading as "any moment now" and steer to the pending
 * step's manual retry.
 */
export function useRegistrationEscalated(): boolean {
  const registrations = useRegistrationReads()
  const now = useStore(wallClock)
  return (
    registrationUiState(currentRegistration(loadedRegistrations(registrations)), now) ===
    "escalated"
  )
}

/**
 * True for an open record whose address the relayer never heard about and whose background driver
 * has stopped re-sending it. Only the pending step's forced retry publishes it now, so no surface
 * may ask for a deposit at it: money sent there is not swept until the claim is published.
 */
export function useRegistrationPublishStalled(record: PendingRegistrationRecord | null): boolean {
  const escalated = useRegistrationEscalated()
  return record !== null && !record.broadcast && escalated
}

/**
 * Whether a surface may show the record's address. Until its broadcast lands nothing sweeps a deposit
 * there. A record whose predecessor spent the rail is never broadcast; only a manual sweep registers it.
 */
export function registrationAddressPublished(record: PendingRegistrationRecord): boolean {
  return record.broadcast || record.replaced?.broadcastSpent === true
}

// ── Logout gate ────────────────────────────────────────────────────────────────

/**
 * Whether a claim for this wallet on this chain is still being driven. Logout is refused while one
 * is; an escalated record has stopped retrying on its own and no longer holds the user.
 */
export function logoutBlockedByRegistration(
  records: readonly PendingRegistrationRecord[],
  identity: WalletIdentity | null,
  nowMs: number = Date.now(),
): boolean {
  if (!identity) return false
  const address = identity.address.toLowerCase()
  return records.some(
    (r) =>
      !isTerminalRegistrationPhase(r.phase) &&
      r.l2Address.toLowerCase() === address &&
      !isRegistrationEscalated(r, nowMs),
  )
}

export function isLogoutBlockedByRegistration(
  own: Pick<Session, "registrations" | "identity">,
): boolean {
  const { registrations, identity } = own
  // Records that cannot be read may hold funds in flight.
  if (registrations.view.get().failed) return true
  return logoutBlockedByRegistration(loadedRegistrations(registrations), identity.get().value)
}

// ── Lost-race notice ───────────────────────────────────────────────────────────

/** A lost name the user has not been told about: which tag went, and which steer to offer.
 *  `recovery` means the account holds a different name — steer to enter, never to a new claim. */
export interface LostRegistrationNotice {
  kind: "taken" | "failed" | "recovery"
  tag: string
}

/** The record whose loss the user has not been told about: a recovery first, else a failure. */
function owedNotice(registrations: Registrations): PendingRegistrationRecord | null {
  const records = loadedRegistrations(registrations)
  const recovery = [...records].sort((a, b) => b.startTime - a.startTime).find(recoveryOwed)
  if (recovery) return recovery
  const failed = latestFailedRegistration(records)
  return failed && !failed.notice?.acknowledged ? failed : null
}

/**
 * The lost outcome still owed to the user. Retraction wipes the identity but leaves the record, so
 * the steer survives the reload that a lost race otherwise sends the user through as a stranger.
 */
export function lostRegistrationNotice(
  registrations: Registrations,
): LostRegistrationNotice | null {
  const record = owedNotice(registrations)
  if (!record) return null
  if (record.phase === "confirmed") return { kind: "recovery", tag: record.tag }
  return { kind: record.phase === "failed_taken" ? "taken" : "failed", tag: record.tag }
}

/** One-shot: the notice renders until the user takes it in, and a later loss surfaces its own. */
export async function acknowledgeLostRegistration(
  registrations: Pick<RegistrationStore, "view" | "apply">,
): Promise<void> {
  const record = owedNotice(registrations)
  if (record) await registrations.apply(record.sipaAddress, { type: "noticeAcknowledged" })
}

/**
 * The user gave up on the open claim. Closing the record is what reopens the tag surfaces: while
 * it stays open the deposit gate stays shut. The pending identity goes with it — the name may yet
 * land on chain, and a name the wallet no longer tracks must never be presented as owned.
 *
 * Refused (`false`) while the op may still land: a stamped attempt or a promoted hash means the
 * bundler could hold it, and closing the record would discard the only watcher for a name about to
 * become the user's. Those settle to confirmed or failed on their own, and both have a flow.
 */
export async function abandonPendingRegistration(
  own: Pick<Session, "registrations" | "namespace" | "database" | "identity">,
  account?: string,
): Promise<boolean> {
  const records = loadedRegistrations(own.registrations)
  const record = account ? latestRegistration(records, account) : currentRegistration(records)
  if (!record) return true
  if (hasCustody(record)) return false
  const identity = own.identity.get().value
  // A pending identity must never be presented as owned.
  const retract =
    (!account || isIdentityRecord(identity, record)) &&
    isTagPresentationPending(own.registrations, identity)
  const { registrations, namespace, database } = own
  await database.write(async (w) => {
    await registrations.apply(record.sipaAddress, { type: "abandoned" }, w.scoped(namespace.prefix))
    if (retract) stageIdentity(w, namespace.prefix, null)
  })
  return true
}
