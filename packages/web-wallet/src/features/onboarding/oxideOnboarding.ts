import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
/**
 * Web glue for the onboarding rails, over shared front-core primitives
 * (`startOxideRegistrationSession`, `resolveTagViaRegistry`): the gasless L1 NameClaim
 * (account-service), the ClaimFPC eligibility witness every sponsored rail batches its
 * subscription with, and the returning-user recovery flows (reuse a passkey for a new
 * tag; fresh-device enter via on-chain lookup). Fresh passkey-account creation runs
 * through front-core's `useAccount().createAccount`.
 *
 * Onboarding's account-service gate accepts a synthetic keyId against an `IS_TEST_MODE`
 * deployment (sandbox, the e2e); a real deployment still needs a credential provider wired
 * into `claimTag`'s `AccountServiceClient` before its gated routes will pass (tracked
 * alongside the registration-by-deposit rewrite — see docs/proposals/registration-fee-plan.md).
 */
import { forgetDepositAdmission, refundedEntry } from "../identity/admission"
import { currentFpcFundingCut } from "../fees/fpcFundingCut"
import { assertEarnedQuote } from "./earnedQuote"
import {
  assertRegistrationRefunded,
  assertRegistrationUnfunded,
  reopenRefundedDeposit,
} from "./registrationQuoteRecovery"
import { Fr } from "@aztec/aztec.js/fields"
import { keccak256, concatHex, toBytes, toHex, type Hex } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import { L2_BINDING_MESSAGE_PREFIX } from "@obsidion/core/constants"
import {
  AccountServiceClient,
  AccountStorage,
  composeWireNameHash,
  matchWireNameHash,
  createOxideL1Reader,
  resolveStoredCredentialId,
  createRegistrationSipaDeriver,
  deriveBootstrapKey,
  pubkeyToR1KeyArg,
  readInstalledPasskeyKey,
  requireVerifiedIdentity,
  resolveOxideIdentity,
  resolveRecoveredMsk,
  startOxideRegistrationSession,
  StoredAddressMismatchError,
  type AnchorTier,
  type BootstrapKeyProvider,
  NameClaimStore,
  type PendingRegistrationRecord,
  type NameClaimResponse,
  type NameTakenReason,
  type OxideL1Reader,
  type OxideRegistrationSessionDeps,
  type PasskeyCredentialCandidate,
  type RecoveredCandidates,
  type ResolvedMsk,
  type OxideRegistrationStage,
  type OxideSignDeps,
  type RegistrationBroadcaster,
  goldenTicketCoverage,
} from "@obsidion/front-core"
import { SANDBOX_REGISTRATION_BENEFICIARY_ID } from "@obsidion/core/constants"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { makeRegistrationDepositSeeder } from "./registrationDepositSeed"
import {
  readRegistrationSchedule,
  resolveBeneficiary,
  saveRegistrationTerms,
  wireTermsFundTicket,
  type RegistrationTerms,
} from "./registrationTerms"
import { linkIdentity } from "../paylink/linkIdentity"
import {
  archiveReplacedRegistration,
  forgetReplacedRegistration,
  getPendingStore,
} from "./webRegistration"
import { updateTicketSignup, type TicketSignupStash } from "../paylink/claimStash"
import { redeemGoldenTicketForLink } from "./goldenTicket"
import { createWebRegistrationBroadcaster } from "./webRegistrationBroadcast"
import {
  ContractService,
  type ObsidionWallet,
  type ObsidionAccount,
  type AlphaAuthProvider,
  type NameClaimWitness,
  type OxideAccountBinding,
  type PrfSlot,
  type RecoverPasskeyResult,
} from "@obsidion/sdk"
import { getOxideTuple, l1PublicClient, oxideEnvFor, requireTupleField } from "../../config/oxideTuple"
import type { WebWalletConfig } from "../../config/env"
import {
  NoPrfError,
  PasskeyPolicyError,
  type PasskeyRequestScope,
  currentDevicePosture,
} from "@obsidion/passkey-web"
import { GateCancelledError, type CeremonyGate } from "../identity/ceremonyGate"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import {
  type BeginRecoveryResult,
  HintedKeyMismatchError,
  type MismatchVerdict,
  type Observation,
  type UnsettledRecovery,
  type WebRecoverResult,
  isUnsettled,
} from "../../platform/auth/WebAlphaAuthService"
import { usertagFor } from "../../platform/auth/WebPasskeyIdentityMap"
import {
  awaitHandoffMaterial,
  takeHandoffMaterial,
  type HandoffMaterial,
} from "../../platform/storage/handoffMaterial"
import { anchorTiers, bootstrapKeyProvider, enterTiers, requireResolved } from "./recoveryProbes"
import { generationFactories, loadOxideGenerations } from "./oxideGenerations"
import { resolveTagForCommit } from "../contacts/registryResolution"

const NAME_GRANT_KEY = "obsidion.name-grant"
let nameGrant: string | undefined

export function stashInboundNameGrant(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has("grant")) return

  nameGrant = url.searchParams.get("grant") || undefined
  try {
    if (nameGrant) window.sessionStorage.setItem(NAME_GRANT_KEY, nameGrant)
    else window.sessionStorage.removeItem(NAME_GRANT_KEY)
  } catch {
    // The in-memory copy still keeps this page's claim usable when storage is unavailable.
  }

  url.searchParams.delete("grant")
  window.history.replaceState(window.history.state, "", url)
}

export function nameGrantToken(): string | undefined {
  if (nameGrant) return nameGrant
  try {
    return window.sessionStorage.getItem(NAME_GRANT_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export type ClaimStatus = "reserved" | "claimed"

export type EnterResult =
  | { entered: true; handle: string; address: string; account: ObsidionAccount }
  /** The passkey's predicted account has no Registry record: a nameless account, or onboarding
   *  died before the claim. The caller decides — nameless re-entry needs the recovered account
   *  and the bootstrap key for the admission check. */
  | {
      entered: false
      reason: "unclaimed"
      account: ObsidionAccount
      bootstrap: PrivateKeyAccount
      /** The wire domain a claimed tag hashes under, to name a reservation the caller finds. */
      ensDomain: string
    }
  /** Claim found; the plaintext tag is needed to name it (hash-only on-chain). */
  | { entered: false; reason: "confirm"; claim: EnteredClaim; account: ObsidionAccount }
  /** A `cacheOnly` entry that no ceremony-free source answered: nothing was asked or written. */
  | { entered: false; reason: "ceremony-required" }
  /** No anchor named either candidate key. Nothing was committed or written. Under a credential
   *  hint the result also says which credential answered and what each candidate derived, or that
   *  this browser's own record for the credential no longer reproduces from the passkey, so the
   *  caller can name the failure. */
  | {
      entered: false
      reason: "unknown"
      credentialId?: string
      /** The settled signing key, so a tag diagnosis can match this attempt against the account. */
      pubkey?: string
      addresses?: string[]
      /** Which device answered and its class, for the screen's diagnosis. */
      observed?: Observation
      storedAddressMismatch?: boolean
      /** Present only when a record was mismatched: a certain wrong key here, or the weaker miss. */
      verdict?: MismatchVerdict
    }

/** The recovered on-chain claim, pending a plaintext tag to name it. */
export interface EnteredClaim {
  nameHash: string
  address: string
  ensDomain: string
}

/**
 * Key material the L1 claim + FPC subscribe steps need, gathered after
 * `useAccount().createAccount` (or a recovery flow here) has committed the MSK.
 */
export interface OnboardingKeys {
  account: ObsidionAccount
  secretKey: Fr
  authProvider: AlphaAuthProvider
  /** 0x-prefixed 64-byte (x‖y) passkey R1 pubkey. */
  pubkeyHex: string
}

function bigintTo32(value: bigint): Uint8Array {
  return toBytes(toHex(value, { size: 32 }))
}

function pubkeyHexFrom(x: Buffer, y: Buffer): string {
  return `0x${Buffer.concat([x, y]).toString("hex")}`
}

/** Persist the account so a reload's `useAccount` mount can recover it. */
async function persistAccount(account: ObsidionAccount, credentialId: string, pubkey: string) {
  await AccountStorage.get().addWebauthnAccount("Account 1", account.getCompleteAddress().toString(), {
    credentialId,
    pubkey,
    authenticatorType: "platform",
  })
}

/**
 * Adopt a resolved candidate: rebuild the account on this wallet, record the breadcrumb, then
 * commit the MSK and persist the account record — the shared tail of every recovery flow. Only
 * called with a candidate an anchor named. Everything that can fail runs before the session
 * switches, and the identity-map record precedes the commit so a failure after it still leaves a
 * record the next unlock verifies against. `beforeCommit` runs once the account and its record
 * exist and before storage moves to the new account: the last moment the previous account's
 * records can be closed where they live. The attempt's cancel and the caller's `stillOwns` make one
 * ownership predicate, asked before every write and by each store under its own lock: a cancel
 * that landed on the way ends in the cancel, and nothing is written after it.
 */
async function adoptRecoveredAccount(
  wallet: ObsidionWallet,
  recovered: RecoverPasskeyResult,
  msk: Fr,
  slot: PrfSlot,
  attempt: AbortSignal,
  beforeCommit?: () => Promise<void>,
  stillOwns?: () => boolean,
): Promise<ObsidionAccount> {
  const auth = getAuthService()
  const owns = () => !attempt.aborted && (stillOwns === undefined || stillOwns())
  const ended = () => !owns()
  if (ended()) throw new GateCancelledError()
  const account = await wallet.createObsidionAccount(msk, recovered.authProvider)
  if (ended()) throw new GateCancelledError()
  await auth.recordRecoveryMetadata(
    {
      credentialId: recovered.credentialId,
      l2Address: account.getAddress().toString(),
      pubkey: recovered.pubkey,
      prfSlot: slot,
      isMskRoot: true,
      authenticatorType: "platform",
      transports: recovered.transports,
    },
    owns,
  )
  if (ended()) throw new GateCancelledError()
  await beforeCommit?.()
  // The session switches here; a cancel that landed during the awaits above must not switch it.
  if (ended()) throw new GateCancelledError()
  const input = { secretKey: msk, authProvider: recovered.authProvider }
  if ((await auth.commitSecret(input, owns)) === false) throw new GateCancelledError()
  try {
    await persistAccount(account, recovered.credentialId, recovered.pubkey)
  } catch (err) {
    throw markCommitted(err)
  }
  return account
}

/**
 * The session had already switched when this error was thrown: a screen must not read it as an
 * arrival failure, and a switch to the same account moves no storage id that could tell it so.
 */
export const isCommittedFailure = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { committed?: boolean }).committed === true

const markCommitted = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? Object.assign(err, { committed: true }) : err

/** `derive` computed once per key, and every address it produced, in derivation order. */
function collectingDeriver(derive: (msk: Fr) => Promise<string>) {
  const derived = new Map<string, Promise<string>>()
  const addresses: string[] = []
  return {
    addresses,
    derive: (msk: Fr) => {
      const key = msk.toString()
      let pending = derived.get(key)
      if (!pending) {
        pending = derive(msk).then((address) => {
          addresses.push(address)
          return address
        })
        derived.set(key, pending)
      }
      return pending
    },
  }
}

/** `deriveAccountAddress` bound to the wallet and a settled signing key, in the string form every anchor compares. */
const deriveAddressWith = (wallet: ObsidionWallet, pubkeyHex: string) => async (msk: Fr) =>
  (await wallet.deriveAccountAddress(msk, pubkeyHex)).toString()

/**
 * Gather the key material the claim + FPC steps need. Call right after
 * `createAccount` — `getAuthService()` is the same singleton `useAccount` drove,
 * so the MSK / auth provider are already committed.
 */
export async function collectOnboardingKeys(account: ObsidionAccount): Promise<OnboardingKeys> {
  const auth = getAuthService()
  const secretKey = await auth.getSecretKey()
  const authProvider = await auth.getAuthProvider()
  if (!secretKey || !authProvider) {
    throw new Error("wallet is locked — cannot continue onboarding")
  }
  const [x, y] = await authProvider.getPubkeys()
  return { account, secretKey, authProvider, pubkeyHex: pubkeyHexFrom(x, y) }
}

export async function getClaimStatus(handle: string): Promise<ClaimStatus> {
  const resolution = await resolveTagForCommit(handle)
  // Unclaimed names are reserved for whoever typed them; a claimed one (incl. a
  // stale-rollup record) routes to /enter, where the passkey proves ownership.
  return resolution.status === "notFound" ? "reserved" : "claimed"
}

/**
 * The tag cannot be claimed, and why. The reason decides where the user goes next, so it survives
 * as far as the copy rather than collapsing into one failure.
 */
export class NameTakenError extends Error {
  constructor(readonly reason: NameTakenReason, readonly handle: string) {
    super(`@${handle} is already taken`)
    this.name = "NameTakenError"
  }
}

/** The asserted passkey derives a different account than the one the claim was started with. */
export class PasskeyMismatchError extends PasskeyPolicyError {
  constructor() {
    super("that isn't the passkey this claim was started with")
    this.name = "PasskeyMismatchError"
  }
}

/**
 * What a hand-off can tell the wallet about an existing passkey so entering is a single prompt:
 * the credential to assert with, and its public key (raw 64-byte `x||y`, hex), which saves the
 * second assertion that would otherwise recover it. Both are checked against the signature; a
 * hint that does not match throws rather than selecting a key. `expectedL2Address` and
 * `policyVersion` come from a campaign that already follows this wallet's slot rule; the address
 * only orders and narrows the candidates, it never anchors one on its own. `discover` leaves the
 * browser's list open instead of naming a credential; `chooser` bypasses the cache and hand-off so
 * the user picking a different passkey is never answered by a saved key.
 */
export interface PasskeyHints {
  credentialId?: string
  pubkeyHex?: string
  expectedL2Address?: string
  policyVersion?: string
  discover?: boolean
  chooser?: boolean
}

/** The hand-off contract version whose `expectedL2Address` was derived under this wallet's slot rule. */
export const HANDOFF_POLICY_VERSION = "phone-v1"

/**
 * Which passkey a ceremony asks for: a hinted hand-off, a known credential, or the open chooser.
 * `handoff` marks the hand-off navigation itself, the one place bridge material may be taken.
 * `discover` runs a discoverable ceremony (no credential pinned); `chooser` bypasses the
 * ceremony-free sources (cache and hand-off) so no saved key answers.
 */
export type CeremonyRequest = {
  credentialId?: string
  pubkeyHex?: string
  discover?: boolean
  chooser?: boolean
  handoff?: boolean
}

/**
 * Where the key comes from, decided without a ceremony: material the campaign bridge left for
 * this hand-off, the key this session already holds, or a ceremony described by `request`.
 */
/** The hand-off needs a passkey prompt, which only a user's tap may open. */
export class CeremonyRequiredError extends Error {
  constructor() {
    super("a passkey prompt needs a tap")
    this.name = "CeremonyRequiredError"
  }
}

export type KeySource =
  | { kind: "handoff"; result: RecoverPasskeyResult; slot?: PrfSlot }
  | { kind: "cache"; result: RecoverPasskeyResult }
  | { kind: "ceremony-required"; request: CeremonyRequest }

/** How long a hand-off waits for the bridge's write when the material is not there yet. */
const HANDOFF_MATERIAL_WAIT_MS = 2_000

let primedMaterial: { key: string; value: Promise<HandoffMaterial | null> } | undefined

/**
 * Start waiting for the campaign bridge's write now.
 *
 * A passkey prompt may only open while the user's tap still counts as activation, and this wait
 * would otherwise sit between the two and spend it — leaving the browser to offer another device
 * instead of the passkey sitting on this one. Called as the hand-off screen opens, the wait is
 * over by the time anything is tapped.
 */
export function primeHandoffMaterial(credentialId: string | undefined): void {
  if (!credentialId) return
  const rpId = getAuthService()?.rpId
  if (!rpId) return
  const key = `${rpId}:${credentialId}`
  if (primedMaterial?.key === key) return
  const value = awaitHandoffMaterial(credentialId, rpId, HANDOFF_MATERIAL_WAIT_MS)
  value.catch(() => {})
  primedMaterial = { key, value }
}

/**
 * The primed wait when it is for this passkey, else a fresh one. A primed wait that ended empty
 * may simply have been early — the frame's write can land after it — so the tap reads once more,
 * without waiting: the read costs nothing the tap needs.
 */
function handoffMaterialFor(credentialId: string, rpId: string): Promise<HandoffMaterial | null> {
  const key = `${rpId}:${credentialId}`
  if (primedMaterial?.key === key) {
    // The wait is spent once. Every later attempt for this passkey reads storage at once instead:
    // the material is single-take, and a tap must never sit through a second wait — on a phone
    // that wait alone would cost the activation the prompt needs.
    const { value } = primedMaterial
    primedMaterial = { key, value: Promise.resolve(null) }
    return value.then((material) => material ?? takeHandoffMaterial(credentialId, rpId))
  }
  return awaitHandoffMaterial(credentialId, rpId, HANDOFF_MATERIAL_WAIT_MS)
}

/** Test seam: forget a primed wait. */
export function __resetPrimedHandoffMaterialForTests(): void {
  primedMaterial = undefined
}

/**
 * `restore: false` consults only a key already in memory: a call answering a tap must not start
 * the cache proof on the way to the prompt.
 */
export async function resolveKeySource(
  hints?: CeremonyRequest,
  options?: { restore?: boolean },
): Promise<KeySource> {
  const request: CeremonyRequest = { ...hints }
  // The chooser is the user asking for a different passkey: no cached source may answer for them.
  if (request.chooser) return { kind: "ceremony-required", request }
  const service = getAuthService()
  if (request.handoff && request.credentialId) {
    const material = await handoffMaterialFor(request.credentialId, service.rpId)
    if (material) {
      try {
        return {
          kind: "handoff",
          result: await service.recoverFromHandoffMaterial(material),
          ...(material.slot ? { slot: material.slot } : {}),
        }
      } catch (err) {
        // Material with no usable candidate is spent, and what follows decides. A rotated
        // credential is refused here as it would be after a ceremony.
        if (!(err instanceof NoPrfError)) throw err
      }
    }
  }
  const cached = await service.recoverFromCache(
    options?.restore === false ? { restore: false } : undefined,
  )
  if (cached && (!request.credentialId || cached.credentialId === request.credentialId)) {
    return { kind: "cache", result: cached }
  }
  return { kind: "ceremony-required", request }
}

/**
 * The recovery `request` describes; unsettled when this browser holds no record for the passkey.
 * `signal`, when the gate handed one out, ends the prompt on the attempt's cancel.
 */
async function ceremonyFor(
  request: CeremonyRequest,
  signal: AbortSignal | undefined,
  own?: PasskeyRequestScope,
): Promise<BeginRecoveryResult> {
  const cancel = { ...(signal ? { signal } : {}), ...(own ? { own } : {}) }
  if (request.discover) return getAuthService().beginRecovery({ discover: true, ...cancel })
  return request.credentialId && request.pubkeyHex
    ? await getAuthService().adoptKnownPasskey({
        credentialId: request.credentialId,
        pubkeyHex: request.pubkeyHex,
        ...cancel,
      })
    : await getAuthService().beginRecovery({ credentialId: request.credentialId, ...cancel })
}

/** A gate that hands out no attempt signal (the tests' stand-ins) gets one that never cancels. */
const attemptFrom = (signal: AbortSignal | undefined): AbortSignal => signal ?? new AbortController().signal

/**
 * The ceremony `request` describes, after the screen's gate, with the attempt the gate started.
 * `cancel` is the caller's: checked before the gate opens an attempt and again before the prompt,
 * so a cancel during the reads that precede it starts nothing. A cancel past that point is the
 * screen's to hand to the gate, whose attempt the ceremony runs under; every write behind the
 * prompt asks the caller's cancel as well, through the ownership predicate each flow builds.
 */
async function ceremonyPath(
  request: CeremonyRequest,
  gate: CeremonyGate,
  cancel?: AbortSignal,
  own?: PasskeyRequestScope,
) {
  if (cancel?.aborted) throw new GateCancelledError()
  const { signal } = await gate()
  if (cancel?.aborted) throw new GateCancelledError()
  const attempt = attemptFrom(signal)
  try {
    return { recovered: await ceremonyFor(request, signal, own), attempt }
  } catch (err) {
    // A cancel mid-prompt comes back as the browser's abort; it is reported as the cancel.
    throwIfCancelled(attempt)
    throw err
  }
}

/**
 * Key material for `hints`: a ceremony-free source when one answers, else the gate and a ceremony. A
 * ceremony-free source runs under the caller's `cancel` as its attempt, so closing the screen ends
 * its adoption the way it ends a prompt's.
 */
async function keyMaterial(
  hints: CeremonyRequest | undefined,
  gate: CeremonyGate,
  cancel?: AbortSignal,
  silentOnly = false,
  own?: PasskeyRequestScope,
): Promise<{
  recovered: BeginRecoveryResult
  source: KeySource["kind"]
  /** The slot the campaign's material names as its account, when it names one. */
  slot?: PrfSlot
  attempt?: AbortSignal
}> {
  const source = await resolveKeySource(hints)
  if (source.kind !== "ceremony-required") {
    return {
      recovered: source.result,
      source: source.kind,
      attempt: cancel,
      ...(source.kind === "handoff" && source.slot ? { slot: source.slot } : {}),
    }
  }
  if (silentOnly) throw new CeremonyRequiredError()
  return {
    ...(await ceremonyPath(source.request, gate, cancel, own)),
    source: "ceremony-required",
  }
}

const throwIfCancelled = (attempt: AbortSignal) => {
  if (attempt.aborted) throw new GateCancelledError()
}

/** How long a sign-in waits for the L1 accounts to name the passkey's key before asking the passkey again. */
const INSTALLED_KEY_BUDGET_MS = 5_000

type BudgetOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "read-failed"; error: unknown }
  | { kind: "cancelled" }

/**
 * `read` bounded by `ms` and by every signal in `cancels`. Whatever ends the wait also aborts the
 * signal `read` was given, so it starts no further step, and releases the timer and listeners.
 */
async function withinBudget<T>(
  read: (stop: AbortSignal) => Promise<T>,
  ms: number,
  cancels: readonly AbortSignal[],
): Promise<BudgetOutcome<T>> {
  if (cancels.some((signal) => signal.aborted)) return { kind: "cancelled" }
  const stop = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => stop.abort()
  try {
    const ended = new Promise<BudgetOutcome<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), ms)
      stop.signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true })
      for (const signal of cancels) signal.addEventListener("abort", onAbort, { once: true })
    })
    const answered = read(stop.signal).then(
      (value): BudgetOutcome<T> => ({ kind: "value", value }),
      (error): BudgetOutcome<T> => ({ kind: "read-failed", error }),
    )
    return await Promise.race([answered, ended])
  } finally {
    clearTimeout(timer)
    for (const signal of cancels) signal.removeEventListener("abort", onAbort)
    stop.abort()
  }
}

/**
 * The key the L1 accounts of `recovered`'s master keys installed, when they name exactly one of its
 * two possible keys within the budget; otherwise undefined, and the passkey is asked again. A cancel
 * is reported by the caller's own check.
 */
async function installedKeyFor(
  recovered: UnsettledRecovery,
  l1: OxideL1Reader,
  accountFactories: readonly Hex[],
  cancels: readonly AbortSignal[],
): Promise<string | undefined> {
  const masterKeys = [recovered.candidates.first, recovered.candidates.second].filter(
    (msk): msk is Fr => msk !== undefined,
  )
  const outcome = await withinBudget(
    (stop) =>
      readInstalledPasskeyKey(masterKeys, recovered.pubkeyCandidates, {
        reader: l1,
        accountFactories,
        stop,
      }),
    INSTALLED_KEY_BUDGET_MS,
    cancels,
  )
  if (outcome.kind === "value") return outcome.value
  // The error's text can carry the RPC URL, so only its class is logged.
  if (outcome.kind === "timeout") {
    console.warn("[oxideOnboarding] installed passkey key: timeout; asking the passkey again")
  } else if (outcome.kind === "read-failed") {
    const name = outcome.error instanceof Error ? outcome.error.name : "unknown"
    console.warn(`[oxideOnboarding] installed passkey key: read-failed (${name}); asking the passkey again`)
  }
  return undefined
}

/**
 * Settle a recovery's public key before the master key is resolved: the address depends on both,
 * so the key comes first. `key`, the one the sign-in's L1 accounts installed at registration,
 * settles without a prompt; otherwise the passkey is asked a second time, behind
 * the gate so the user taps before a prompt that would otherwise open seconds after the last one.
 * The attempt's cancel is checked before every step this adds; nothing here writes.
 */
async function settleRecovery(
  recovered: BeginRecoveryResult,
  gate: CeremonyGate,
  attempt: AbortSignal = attemptFrom(undefined),
  key?: string,
): Promise<WebRecoverResult> {
  if (!isUnsettled(recovered)) return recovered
  throwIfCancelled(attempt)
  if (key) return recovered.settle(key)
  await gate({ again: attempt })
  throwIfCancelled(attempt)
  let settled: WebRecoverResult
  try {
    settled = await recovered.settle(undefined, attempt)
  } catch (err) {
    // A cancel mid-prompt comes back as the browser's abort; it is reported as the cancel.
    throwIfCancelled(attempt)
    throw err
  }
  throwIfCancelled(attempt)
  return settled
}

async function keysFor(
  account: ObsidionAccount,
  recovered: RecoverPasskeyResult,
  secretKey: Fr,
  active?: () => boolean,
): Promise<OnboardingKeys> {
  // The commit has landed and the session has switched, but the keys are only now handed to the
  // caller. A scope cancelled in that window (a modal closed, the gate cancelled), before or during
  // the key read, stops here, so no sweep or pending step runs against a session the user walked
  // away from.
  if (active && !active()) throw new GateCancelledError()
  const [x, y] = await recovered.authProvider.getPubkeys()
  if (active && !active()) throw new GateCancelledError()
  return {
    account,
    secretKey,
    authProvider: recovered.authProvider,
    pubkeyHex: pubkeyHexFrom(x, y),
  }
}

/**
 * The request a sign-in makes: pinned to the hinted credential on any posture, else discoverable
 * on a laptop (its own account chooser lists whatever holds the passkey — this computer, a phone,
 * a key) or for the chooser, else the phone's own pin straight to the biometric.
 */
function signInRequest(options: {
  chooser?: boolean
  hints?: PasskeyCredentialCandidate
}): CeremonyRequest | undefined {
  if (options.hints) {
    return { credentialId: options.hints.credentialId, pubkeyHex: options.hints.pubkeyHex }
  }
  if (options.chooser || currentDevicePosture() === "laptop") {
    return { discover: true, ...(options.chooser ? { chooser: true } : {}) }
  }
  return undefined
}

/**
 * A sign-in's key material, or undefined for a `cacheOnly` call that no ceremony-free source
 * answered. The key source is resolved once, and `cacheOnly` is judged on that one resolution,
 * where a ceremony would otherwise start — so a source that changes under the call can never reach
 * the gate. A hinted key the signature does not carry is the mismatch refusal; every other failure
 * keeps its class.
 */
async function enterKeyMaterial(options: {
  gate: CeremonyGate
  chooser?: boolean
  hints?: PasskeyCredentialCandidate
  signal?: AbortSignal
  cacheOnly?: boolean
  restoreCache?: boolean
  own?: PasskeyRequestScope
}): Promise<{ recovered: BeginRecoveryResult; attempt?: AbortSignal } | undefined> {
  const request = signInRequest(options)
  try {
    const source = await resolveKeySource(request, { restore: options.restoreCache })
    if (source.kind !== "ceremony-required") {
      return { recovered: source.result, attempt: options.signal }
    }
    if (options.cacheOnly) return undefined
    return await ceremonyPath(source.request, options.gate, options.signal, options.own)
  } catch (err) {
    if (err instanceof HintedKeyMismatchError) throw new PasskeyMismatchError()
    throw err
  }
}

/** The candidate that derives `address`, if either does. A failed derivation propagates. */
async function candidateDeriving(
  recovered: RecoveredCandidates,
  address: string,
  deriveAddress: (msk: Fr) => Promise<string>,
): Promise<{ msk: Fr; slot: PrfSlot } | undefined> {
  const wanted = address.toLowerCase()
  for (const slot of ["first", "second"] as const) {
    const msk = recovered.candidates[slot]
    if (msk && (await deriveAddress(msk)).toLowerCase() === wanted) return { msk, slot }
  }
  return undefined
}

/**
 * Reuse an EXISTING passkey for an account this browser already knows the address of (a pending
 * registration's `l2Address`, or a nameless identity's) instead of minting a fresh credential.
 * Both candidate keys are derived and the one that reproduces `expectedL2Address` is adopted; when
 * neither does, `PasskeyMismatchError` is thrown having mutated nothing. `signal` is the caller's
 * cancel — a closed sheet — and ends the adoption wherever it lands, prompt or no prompt.
 */
export async function reusePasskeyAccount(
  wallet: ObsidionWallet,
  expectedL2Address: string,
  hints: PasskeyHints | undefined,
  gate: CeremonyGate,
  signal?: AbortSignal,
  own?: PasskeyRequestScope,
): Promise<OnboardingKeys> {
  const { recovered, attempt } = await keyMaterial(hints, gate, signal, false, own)
  // The attempt owns the prompt; the caller's cancel owns everything after it.
  const owns = () => !attempt?.aborted && !signal?.aborted
  const settled = await settleRecovery(recovered, gate, attempt)
  if (!owns()) throw new GateCancelledError()
  const picked = await candidateDeriving(settled, expectedL2Address, deriveAddressWith(wallet, settled.pubkey))
  if (!picked) throw new PasskeyMismatchError()
  const account = await adoptRecoveredAccount(
    wallet,
    settled,
    picked.msk,
    picked.slot,
    attemptFrom(attempt),
    undefined,
    owns,
  )
  return keysFor(account, settled, picked.msk, owns)
}

/** A hand-off's key material and the candidate an anchor named. Nothing has been written yet. */
export interface ResolvedHandoff {
  recovered: RecoverPasskeyResult
  msk: Fr
  slot: PrfSlot
  /** The ceremony's attempt, when the gate handed one out; a cancel on it stops the adoption. */
  attempt?: AbortSignal
  /** The caller's cancel; the adoption asks it beside the attempt before every write. */
  cancel?: AbortSignal
}

/**
 * Resolve a passkey this browser has no address for: a campaign hand-off, or a returning user
 * with no local record. The candidates go through the hand-off's anchor tiers (the Registry, the
 * slot the campaign's material names, then account-service's claim ledger); a hand-off address,
 * when it names one candidate, orders the candidates and narrows the probes to that one. No anchor → `NoWalletForPasskeyError`. Writes
 * nothing, so the caller can settle what else this origin holds before `adoptHandoff` switches
 * the session. `signal` is the caller's cancel; the attempt handed back carries it.
 */
export async function resolveHandoff(
  wallet: ObsidionWallet,
  contractService: ContractService,
  config: WebWalletConfig,
  hints: PasskeyHints | undefined,
  gate: CeremonyGate,
  signal?: AbortSignal,
  /** Take the bridge's material or refuse: no prompt, so this can run with no tap behind it. */
  silentOnly = false,
  own?: PasskeyRequestScope,
): Promise<ResolvedHandoff> {
  // Started, not awaited: these are chain and network reads, and awaiting them here would spend
  // the tap's activation before the passkey is ever asked for. Nothing below needs them until the
  // key is in hand.
  const generationsPending = loadOxideGenerations(wallet, contractService, config)
  generationsPending.catch(() => {})
  let {
    recovered: begun,
    source,
    attempt,
    slot: campaignSlot,
  } = await keyMaterial({ ...hints, handoff: true }, gate, signal, silentOnly, own)
  let recovered = await settleRecovery(begun, gate, attempt)
  const generations = await generationsPending
  // The campaign's word holds for the keys its material carried; a ceremony's keys are the same
  // passkey's, so the slot it named is still the one it signed up under.
  const tiers = anchorTiers(
    config,
    generations,
    campaignSlot ? { candidates: recovered.candidates, slot: campaignSlot } : undefined,
  )
  // The deriver is bound per recovery result: a fallback ceremony may recover a different key. It
  // memoizes, so the identity read below reuses the address the probes already derived.
  let deriveAddress!: (msk: Fr) => Promise<string>
  const decide = async (recovered: RecoverPasskeyResult) => {
    deriveAddress = collectingDeriver(deriveAddressWith(wallet, recovered.pubkey)).derive
    const narrowed = await narrowToHint(recovered, hints, deriveAddress)
    let result = await resolveRecoveredMsk(narrowed, deriveAddress, tiers)
    // A hint naming the wrong sibling costs one more pass over both candidates, not the account.
    if (result.kind === "unknown" && narrowed !== recovered) {
      result = await resolveRecoveredMsk(recovered, deriveAddress, tiers)
    }
    return result
  }
  /** Whether any candidate in hand still derives the address this browser recorded for the passkey. */
  const derivesRecorded = async (r: RecoverPasskeyResult) =>
    !r.expectedAddress ||
    (await candidateDeriving(r, r.expectedAddress, deriveAddressWith(wallet, r.pubkey))) !== undefined
  /**
   * A record naming an address no key in hand derives is either the campaign having evaluated the
   * slot this browser did not record, or a record kept from a retired deployment whose addresses
   * this key no longer makes. Only the first is worth a ceremony, and only when a ceremony could
   * turn up a key this does not already hold: a passkey has two PRF slots, so material carrying
   * both is every key there is, and a record neither derives is stale. Stale, not wrong — the
   * address steps aside and the anchors decide, as they do for a browser holding no record at all.
   * The rotated-credential refusal is unaffected: that is a key check, made before any of this.
   */
  const everySlot = recovered.candidates.first !== undefined && recovered.candidates.second !== undefined
  if (source === "handoff" && everySlot && !(await derivesRecorded(recovered))) {
    recovered = { ...recovered, expectedAddress: undefined }
  }
  // Bridge material that does not derive this browser's own record for its passkey (the campaign
  // evaluates one slot) is no candidate for that record: it is spent, and the ceremony decides.
  const usable = source !== "handoff" || (await derivesRecorded(recovered))
  let result: ResolvedMsk = usable ? await decide(recovered) : { kind: "unknown" }
  // Bridge material no anchor names was taken once and is gone; the ceremony decides as before.
  if (result.kind === "unknown" && source === "handoff") {
    if (silentOnly) throw new CeremonyRequiredError()
    ;({ recovered: begun, attempt } = await ceremonyPath(
      { credentialId: hints?.credentialId, pubkeyHex: hints?.pubkeyHex, discover: hints?.discover },
      gate,
      signal,
      own,
    ))
    recovered = await settleRecovery(begun, gate, attempt)
    // The ceremony holds every slot this passkey has. A record none of them derives is stale by
    // the same reasoning as above, and must not fail the sign-in closed.
    if (!(await derivesRecorded(recovered))) {
      recovered = { ...recovered, expectedAddress: undefined }
    }
    result = await decide(recovered)
  }
  const resolved = requireResolved(result)
  // A stored address and the campaign's own record both name a key, not an account. The account
  // this key owns is read the same way the ordinary sign-in reads it, so a name this device cannot
  // attribute refuses here too. A key that owns no account is the campaign's nameless user.
  requireVerifiedIdentity(
    await resolveOxideIdentity(
      generations,
      deriveBootstrapKey(resolved.msk).address,
      await deriveAddress(resolved.msk),
    ),
  )
  throwIfCancelled(attemptFrom(attempt))
  if (signal?.aborted) throw new GateCancelledError()
  return { recovered, msk: resolved.msk, slot: resolved.slot, attempt, cancel: signal }
}

/**
 * Adopt what `resolveHandoff` named: this is the step that switches the session. `beforeCommit`
 * runs after the account and its record exist, before storage moves to the new account. The
 * attempt owns the prompt that produced the material; the caller's cancel owns the adoption.
 */
export async function adoptHandoff(
  wallet: ObsidionWallet,
  { recovered, msk, slot, attempt, cancel }: ResolvedHandoff,
  beforeCommit?: () => Promise<void>,
): Promise<OnboardingKeys> {
  const owns = () => !attempt?.aborted && !cancel?.aborted
  const account = await adoptRecoveredAccount(wallet, recovered, msk, slot, attemptFrom(attempt), beforeCommit, owns)
  return keysFor(account, recovered, msk, owns)
}

/** A hand-off's `l2` in the one form the contract allows: a `0x`-prefixed 32-byte hex address. */
const addressHint = (value: string | undefined) =>
  value && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : undefined

/**
 * A hand-off address is a prefilter: when one candidate derives it, that candidate is probed first
 * and alone. A malformed hint, one matching neither candidate, or a browser holding its own record
 * for the passkey leaves the set whole. It never anchors, because both candidates come from the
 * user's own passkey and a stale or altered link could name the sibling.
 */
async function narrowToHint<R extends BeginRecoveryResult>(
  recovered: R,
  hints: PasskeyHints | undefined,
  deriveAddress: (msk: Fr) => Promise<string>,
): Promise<R> {
  const hint = addressHint(hints?.expectedL2Address)
  if (!hint || hints?.policyVersion !== HANDOFF_POLICY_VERSION || recovered.expectedAddress) {
    return recovered
  }
  const named = await candidateDeriving(recovered, hint, deriveAddress)
  if (!named) return recovered
  return { ...recovered, candidates: { [named.slot]: named.msk }, preferredSlot: named.slot }
}

/**
 * `custody` means onboarding may complete: the registration is confirmed on-chain, or the
 * optimistic session proved the bundler holds the op (`confirmed` distinguishes the two — the
 * confirmation event and the claim cache both key on it). The deferred setup recovers the
 * claim witness from the Registry's `NameClaimed` log, never from this session. `pending` is
 * resumable, never a failure — the durable record carries the state, and the UI shows
 * in-progress copy.
 */
export type ClaimTagOutcome =
  | { kind: "custody"; confirmed: boolean; oxideAccount: string }
  /** `claim` is the fresh NameClaim (+ optional fee waiver) the deposit screen renders — in memory
   *  only, same as the session result it comes from; a resumed record has no claim to show.
   *  `broadcastDone` resolves when the deferred broadcast lands (true) or fails (false), and only
   *  once `startBroadcast` has run it: the screen picks when the proof costs the page. */
  | {
      kind: "pending"
      oxideAccount: string
      claim: NameClaimResponse
      broadcastDone?: Promise<boolean>
      startBroadcast?: () => Promise<boolean>
      /** The network paused paylink tickets before this signup's was redeemed; `claim.terms` say
       *  whether one redeemed earlier still priced it. */
      ticketUnavailable?: true
    }

/**
 * The bootstrap-key request-auth provider for `/domain/sign` (front-core `BootstrapKeyProvider`,
 * PR #1174): the wallet's own bootstrap key signs the request's `clientDataHash` directly.
 */
function bootstrapProviderFor(masterSecret: OnboardingKeys["secretKey"]): BootstrapKeyProvider {
  return bootstrapKeyProvider(deriveBootstrapKey(masterSecret))
}

export function accountServiceFor(
  config: WebWalletConfig,
  keys: Pick<OnboardingKeys, "secretKey">,
): AccountServiceClient {
  // The bootstrap key names the subject in test mode too, so the sandbox binds claims (and earned
  // entitlements) to the same subject production does.
  return new AccountServiceClient(config.accountServiceUrl, {
    testMode: config.accountServiceTestMode,
    // Sandbox testMode skips the HTTP gate; the bootstrap subject still names the ticket owner
    // and the NameClaim's keyId, so the ticket's entitlement prices the claim.
    bootstrapProvider: bootstrapProviderFor(keys.secretKey),
    grantToken: nameGrantToken(),
  })
}

/**
 * The broadcast leg when no wallet is in hand — the machine still returns `awaiting_deposit` (the
 * deposit address is valid; funds wait at the counterfactual address) and a later tick re-broadcasts
 * once the wallet is unlocked. The real rail is {@link createWebRegistrationBroadcaster} (D3a).
 */
const registrationBroadcastSeam: RegistrationBroadcaster = async (payload) => {
  console.warn(
    "[oxideOnboarding] no wallet wired for the registration broadcast — SIPA",
    payload.sipaAddress,
    "will be re-broadcast by a later tick once the wallet is available",
  )
}

/** The registration broadcaster for this session: the real ClaimFPC-sponsored rail when the wallet
 *  is unlocked, else the deposit-address-only fallback a later tick re-broadcasts. */
function broadcasterFor(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet?: ObsidionWallet,
): RegistrationBroadcaster {
  return wallet
    ? createWebRegistrationBroadcaster({
        wallet,
        account: keys.account,
        contractService: ContractService.getInstance(),
        config,
        handle,
      })
    : registrationBroadcastSeam
}

/** The current account's passkey credential id, or a loud failure — registration installs the r1 key
 *  through the sweep and cannot without it. */
async function requireCredentialId(): Promise<string> {
  const credentialId = await resolveStoredCredentialId()
  if (!credentialId) {
    throw new Error("no passkey credential id for the current account — cannot install the r1 key on registration")
  }
  return credentialId
}

/** Assemble the deposit-driven registration session deps (shared by claimTag + the retry sign deps). */
async function registrationSessionDeps(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet?: ObsidionWallet,
  onStage?: (stage: OxideRegistrationStage) => void,
): Promise<OxideRegistrationSessionDeps> {
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  return {
    tag: handle,
    env,
    masterSecret: keys.secretKey,
    l2Address: keys.account.getAddress().toString() as Hex,
    accountService: accountServiceFor(config, keys),
    beneficiary: await resolveBeneficiary(config, Number(SANDBOX_REGISTRATION_BENEFICIARY_ID)),
    // Read live at derivation: the committed fee must be exactly what the controller checks at
    // sweep, and signed terms (when the claim carries them) take precedence over this schedule.
    scheduleFee: () => readRegistrationSchedule(config).then((schedule) => schedule.fee),
    r1Key: pubkeyToR1KeyArg(keys.pubkeyHex),
    passkey: await oxideAccountPasskey(keys.account.getAuthProvider()),
    credentialId: await requireCredentialId(),
    l1: createOxideL1Reader(publicClient),
    deriveRegistrationSipa: createRegistrationSipaDeriver({
      publicClient,
      env,
      tuple,
      network: config.network,
    }),
    broadcast: broadcasterFor(handle, keys, config, wallet),
    seedSipaDeposit: makeRegistrationDepositSeeder({
      feeToken: env.feeToken,
      l1ChainId: env.l1ChainId,
    }),
    // The address is revealed at the checkpoint; the broadcast (client proving + a block) continues
    // behind the pending step and reports through the outcome's broadcastDone.
    deferBroadcast: true,
    pendingStore: getPendingStore(),
    onStage,
  }
}

/**
 * The link's note covers the ticket burn on the advertised ticket schedule at the portal's live
 * cut. An unread cut or an unadvertised schedule prices nothing, and nothing is spent on a guess.
 */
export async function linkCoversTicketBurn(
  amount: bigint,
  advertised: RegistrationSchedule | undefined,
): Promise<boolean> {
  if (!advertised) return false
  const cut = await currentFpcFundingCut()
  return goldenTicketCoverage(amount, advertised, { withdrawalCut: cut, depositCut: cut }).covers
}

/** How a ticket-funded signup's redemption went before its claim was signed. */
export type TicketRedemption = "none" | "redeemed" | "unavailable"

/**
 * A ticket-funded signup (the visitor chose to receive the link into a new account on a network
 * that issues tickets) redeems its golden ticket first, so the claim below quotes the ticket
 * schedule. Every refusal fails closed before the ticket is spent: a missing PXE, a note below the
 * threshold or one that cannot cover the registration burn all surface here, never as a paid quote
 * the link was meant to cover. A network that paused tickets is reported instead: the claim is
 * signed anyway, and the wizard keeps the ticket path only if a ticket redeemed earlier still
 * priced it. The ticket is the one the hosting wizard hands in: a marker another page left in the
 * tab never reaches this signup.
 */
export async function redeemLinkedGoldenTicket(
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet: ObsidionWallet | undefined,
  ticket: TicketSignupStash | null,
): Promise<TicketRedemption> {
  if (!ticket) return "none"
  if (!wallet) throw new Error("wallet is still starting, try again in a moment")
  const outcome = await redeemGoldenTicketForLink({
    wallet,
    accountService: accountServiceFor(config, keys),
    secretKey: keys.secretKey,
    fragment: ticket.fragment,
    covers: linkCoversTicketBurn,
  })
  if (outcome.amount !== undefined) updateTicketSignup({ amount: outcome.amount.toString() })
  switch (outcome.status) {
    case "unavailable":
      return "unavailable"
    case "below_threshold":
      throw new Error("this payment is below the amount that waives the tag price")
    case "cannot_cover":
      throw new Error("this payment cannot cover the account deposit")
  }
  return "redeemed"
}

/**
 * What a registration checkpoint makes durable beside its record: the quote, and the link whose
 * ticket the quote honours. A reopen finds the registration this link funds by that identity, and
 * never proves or claims again for it.
 */
export function checkpointRegistrationTerms(
  account: string,
  tag: string,
  claim: NameClaimResponse,
  opts: { earnedExpected: boolean; ticket: TicketSignupStash | null },
): RegistrationTerms {
  const link =
    opts.ticket && wireTermsFundTicket(claim.terms) ? linkIdentity(opts.ticket.fragment) : undefined
  return {
    account,
    tag,
    deadline: Number(claim.deadline),
    ...(claim.terms
      ? {
          fee: claim.terms.fee,
          minDeposit: claim.terms.minDeposit,
          feeWaived: claim.terms.reduced === true,
        }
      : {}),
    ...(opts.earnedExpected ? { earnedExpected: true } : {}),
    ...(link ? { paylinkFunded: true, paylinkId: link } : {}),
  }
}

export async function claimTag(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet?: ObsidionWallet,
  onStage?: (stage: OxideRegistrationStage) => void,
  requireEarnedQuote = false,
  refundedRecord?: PendingRegistrationRecord,
  replacedRecord?: PendingRegistrationRecord,
  ticket: TicketSignupStash | null = null,
): Promise<ClaimTagOutcome> {
  let ticketUnavailable = false
  let entry: PendingRegistrationRecord["refundedEntry"]
  if (refundedRecord) {
    if (
      handle !== refundedRecord.tag ||
      keys.account.getAddress().toString() !== refundedRecord.l2Address
    ) {
      throw new Error("Use the original wallet to restart this registration.")
    }
    const refund = await assertRegistrationRefunded(refundedRecord, config)
    // The entry the refund earned is priced against the cut, and it rides on the replacement from
    // its checkpoint. Creating that replacement without one would drop the entry for good, so an
    // unread cut stops the restart where the user can retry it.
    const fpcCut = await currentFpcFundingCut().catch(() => undefined)
    if (fpcCut === undefined) {
      throw new Error("This registration's minimum is not available yet. Try again in a moment.")
    }
    entry = refundedEntry(refundedRecord, refund, fpcCut)
  }
  const deps = await registrationSessionDeps(handle, keys, config, wallet, onStage)
  // Entry rides on the replacement record from its checkpoint: the receipt a sign-out clears cannot
  // be rebuilt from an address that holds nothing, and a session that dies after the checkpoint
  // must not lose it.
  if (entry) deps.refundedEntry = entry
  const prior = refundedRecord ?? replacedRecord
  if (prior) {
    // The checkpoint overwrites the old record; a deposit reaching its address later is recovered
    // off this copy, kept even when the name is refused before anything derives. The old address
    // spent the account's one-shot broadcast only if it recorded one, or inherited that: a refund
    // moves L1 funds and says nothing about it.
    archiveReplacedRegistration(prior)
    deps.replaced = {
      sipaAddress: prior.sipaAddress,
      refunded: refundedRecord !== undefined,
      broadcastSpent: prior.broadcast || prior.replaced?.broadcastSpent === true,
    }
  }
  // The address commits the fee, so a quote that only lowered the minimum re-derives the old
  // address: the session re-enters that record under the corrected quote instead of replacing it.
  const sameAddress = (sipaAddress: string) =>
    prior !== undefined && sipaAddress.toLowerCase() === prior.sipaAddress.toLowerCase()
  if (refundedRecord) {
    const derive = deps.deriveRegistrationSipa
    deps.deriveRegistrationSipa = async (args) => {
      const result = await derive(args)
      await assertRegistrationRefunded(refundedRecord, config)
      const reentry = sameAddress(result.sipaAddress)
      if (
        args.owner.toLowerCase() !== refundedRecord.account.toLowerCase() ||
        (reentry && (refundedRecord.fee === undefined || args.fee !== BigInt(refundedRecord.fee)))
      ) {
        throw new Error("The earned quote did not produce a new address for this wallet.")
      }
      if (reentry) {
        // The refund emptied the address the deposit receipt vouches for; entry stays on the record.
        if (entry && !refundedRecord.refundedEntry) {
          await getPendingStore().upsert(refundedRecord.account, { refundedEntry: entry })
        }
        forgetDepositAdmission(refundedRecord)
        forgetReplacedRegistration(refundedRecord.sipaAddress)
        await reopenRefundedDeposit(refundedRecord)
      }
      return result
    }
  }
  if (replacedRecord && !refundedRecord) {
    const derive = deps.deriveRegistrationSipa
    deps.deriveRegistrationSipa = async (args) => {
      const result = await derive(args)
      // A deposit landing at the old address during the quote fetch would be stranded once the
      // checkpoint overwrites its record. Re-check emptiness here, right before that write: a
      // funded old address aborts the replace and keeps its recoverable record instead.
      await assertRegistrationUnfunded(replacedRecord, config)
      if (sameAddress(result.sipaAddress)) forgetReplacedRegistration(replacedRecord.sipaAddress)
      return result
    }
  }
  let quoted: NameClaimResponse | undefined
  const accountService = deps.accountService
  deps.accountService = {
    signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
      // The session checks the name and account on L1 before requesting terms. Redeeming here
      // avoids spending a ticket on an account that already owns a name or on a taken name.
      ticketUnavailable =
        (await redeemLinkedGoldenTicket(keys, config, wallet, ticket)) === "unavailable"
      const claim = await accountService.signDomain(...args)
      if (requireEarnedQuote || refundedRecord)
        assertEarnedQuote(claim.terms, await currentFpcFundingCut().catch(() => undefined))
      quoted = claim
      return claim
    },
  }
  // The quote goes durable with the record: a session that dies past its checkpoint leaves a
  // record whose stored terms would otherwise still price the address it replaced.
  deps.onCheckpoint = async (record) => {
    if (!quoted) return
    saveRegistrationTerms(
      checkpointRegistrationTerms(record.account, handle, quoted, {
        earnedExpected: requireEarnedQuote,
        ticket,
      }),
    )
  }
  const result = await startOxideRegistrationSession(deps)
  switch (result.status) {
    case "taken":
      throw new NameTakenError(result.reason, handle)
    case "already_registered":
      throw new Error(
        result.name
          ? `this passkey already claimed ${result.name} — use Enter instead`
          : "this passkey already claimed another tag — use Enter to recover it",
      )
    case "registered":
      return { kind: "custody", confirmed: true, oxideAccount: result.oxideAccount }
    // awaiting_deposit: the deposit address is derived + the claim is in hand; the sender must fund
    // it before the name registers. Presented as pending — the onboarding screen's deposit panel
    // shows the address + claim, and the detection loop confirms once the relayer sweeps.
    case "awaiting_deposit": {
      // A manual sweep needs the claim cached, and this session's own broadcast may never cache it.
      if (prior) {
        await NameClaimStore.get().put({
          address: prior.l2Address,
          handle,
          nameHash: prior.nameHash,
          signature: result.claim.signature,
          nonce: result.claim.nonce,
          deadline: result.claim.deadline,
          terms: result.claim.terms,
        })
      }
      return {
        kind: "pending",
        oxideAccount: result.oxideAccount,
        claim: result.claim,
        broadcastDone: result.broadcastDone,
        startBroadcast: result.startBroadcast,
        ...(ticketUnavailable ? { ticketUnavailable: true as const } : {}),
      }
    }
  }
}

/**
 * Sign half of the pending step's forced resume tick — the collaborators the machine's re-broadcast
 * branch needs (re-derive the SIPA, re-request the claim, re-publish). The bootstrap key gates
 * `/domain/sign` directly, so this arms on any deployment with an unlocked wallet. With the wallet in
 * hand the re-broadcast rides the real ClaimFPC-sponsored rail; without it the deposit address stays
 * valid and a still-later tick retries.
 */
export async function buildRetrySignDeps(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet?: ObsidionWallet,
): Promise<OxideSignDeps> {
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  return {
    masterSecret: keys.secretKey,
    accountService: accountServiceFor(config, keys),
    r1Key: pubkeyToR1KeyArg(keys.pubkeyHex),
    passkey: await oxideAccountPasskey(keys.account.getAuthProvider()),
    credentialId: await requireCredentialId(),
    l1: createOxideL1Reader(publicClient),
    deriveRegistrationSipa: createRegistrationSipaDeriver({
      publicClient,
      env,
      tuple,
      network: config.network,
    }),
    broadcast: broadcasterFor(handle, keys, config, wallet),
    seedSipaDeposit: makeRegistrationDepositSeeder({
      feeToken: env.feeToken,
      l1ChainId: env.l1ChainId,
    }),
  }
}

/**
 * What both ClaimFPC gates rest on: the name the L1 side commits to, the bootstrap key that
 * CREATE2-derives the OxideAccount holding it, and that key's signature over this L2 address. The
 * signature never leaves the device, and every part re-derives from the master secret.
 */
export async function buildOxideAccountBinding(
  keys: Pick<OnboardingKeys, "account" | "secretKey">,
  nameHash: Hex,
): Promise<OxideAccountBinding> {
  const bootstrap = deriveBootstrapKey(keys.secretKey)
  const bootstrapPub = toBytes(bootstrap.publicKey) // 0x04 || x || y
  const bindingSig = await bootstrap.sign({
    hash: keccak256(
      concatHex([
        toHex(new TextEncoder().encode(L2_BINDING_MESSAGE_PREFIX)),
        keys.account.getAddress().toString() as Hex,
      ]),
    ),
  })
  return {
    nameHash: toBytes(nameHash),
    bootstrapPubKeyX: bootstrapPub.slice(1, 33),
    bootstrapPubKeyY: bootstrapPub.slice(33, 65),
    bindingSig: toBytes(bindingSig).slice(0, 64),
  }
}

/**
 * The NameClaim gate's eligibility witness: the binding above plus the REAL NameClaim the domain
 * owner signed.
 *
 * `nameHash` is what the signature actually covers, so a recovered claim passes the value from the
 * Registry's `NameClaimed` log rather than recomposing it — recovery then needs no plaintext tag,
 * and a stale `handle` can't silently produce a node the signature doesn't match.
 */
export async function buildClaimSubscribeWitness(
  handle: string,
  keys: Pick<OnboardingKeys, "account" | "secretKey">,
  claim: NameClaimResponse,
  config: WebWalletConfig,
  nameHash?: Hex,
): Promise<NameClaimWitness> {
  const tuple = await getOxideTuple(config)
  const ensDomain = requireTupleField(tuple, "ensDomain")
  const node = nameHash ?? composeWireNameHash(handle, ensDomain)
  return {
    ...(await buildOxideAccountBinding(keys, node)),
    nonce: bigintTo32(BigInt(claim.nonce)),
    deadline: bigintTo32(BigInt(claim.deadline)),
    claimSig: toBytes(claim.signature).slice(0, 64),
  }
}

/**
 * Returning user, passkey-first: assert the passkey, settle its signing key (the key the L1 account
 * installed at registration, when it names one; otherwise a second assertion), derive both
 * candidate master keys, and let the anchors say which one is the account — this browser's record
 * if it has one, else the outside records in `enterTiers`. A resolved claim
 * re-registers the account and rebuilds the local records a browser-data wipe destroyed. Only the
 * tag's HASH lives on-chain, so the plaintext still needs a source: a `handle` from the claim
 * link enters directly when its hash matches; otherwise the caller confirms. No anchor →
 * `unknown`, with nothing committed or written.
 *
 * `hints` pins the ceremony to one credential (the tag's, read from L1) on any posture, in place
 * of the open request; the hinted key is checked against the signature, never trusted, and the
 * anchors decide as always. `strictTag` (implied by `hints`) lets only `handle` name the claim.
 * `cacheOnly` enters from a ceremony-free source or reports `ceremony-required` before any gate or
 * prompt; `restoreCache: false` keeps a tap-driven entry from starting the cache proof on its way to
 * the prompt. `signal` is the caller's cancel: with the gate's attempt it is checked before the
 * prompt, after the anchors, after the name read, and before every write, so nothing is committed
 * after a cancel.
 */
export async function enterWithPasskey(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
  handle: string | undefined,
  options: {
    contractService: ContractService
    tiers?: AnchorTier[]
    gate: CeremonyGate
    chooser?: boolean
    hints?: PasskeyCredentialCandidate
    strictTag?: boolean
    signal?: AbortSignal
    cacheOnly?: boolean
    restoreCache?: boolean
    /** The attempt this sign-in runs as, so its requests are reported as that attempt's. */
    own?: PasskeyRequestScope
  },
): Promise<EnterResult> {
  const tuple = await getOxideTuple(config)
  const ensDomain = requireTupleField(tuple, "ensDomain")
  const l1 = createOxideL1Reader(l1PublicClient(config))
  const strict = options.strictTag || options.hints !== undefined
  // Started before the prompt, so the assertion still opens inside the click's activation window,
  // and awaited before the first account prediction.
  const generationsRead = loadOxideGenerations(wallet, options.contractService, config)
  void generationsRead.catch(() => undefined)

  const material = await enterKeyMaterial(options)
  if (!material) return { entered: false, reason: "ceremony-required" }
  const { recovered: begun, attempt } = material
  const active = () => !options.signal?.aborted && !attempt?.aborted
  const throwIfEnded = () => {
    if (!active()) throw new GateCancelledError()
  }

  // A hinted sign-in arrives with its key settled; otherwise the key is settled before any
  // candidate is derived, because the address depends on it.
  const generations = await generationsRead
  let installedKey: string | undefined
  if (isUnsettled(begun)) {
    throwIfEnded()
    const cancels = [options.signal, attempt].filter((s): s is AbortSignal => s !== undefined)
    installedKey = await installedKeyFor(begun, l1, generationFactories(generations), cancels)
    throwIfEnded()
  }
  const recovered = await settleRecovery(begun, options.gate, attemptFrom(attempt), installedKey)
  throwIfEnded()
  const deriver = collectingDeriver(deriveAddressWith(wallet, recovered.pubkey))
  const { observed } = recovered
  const auth = getAuthService()
  let resolved: ResolvedMsk
  let storedAddressMismatch = false
  let verdict: MismatchVerdict | undefined
  try {
    resolved = await resolveRecoveredMsk(recovered, deriver.derive, options.tiers ?? enterTiers(config, generations))
  } catch (err) {
    // This browser's own record for the credential no longer reproduces from the passkey.
    if (!(err instanceof StoredAddressMismatchError)) throw err
    verdict = auth.mismatchVerdict(recovered)
    // The plain path shows the card from the thrown error; the hinted path from the result.
    if (!options.hints) throw Object.assign(err, { verdict })
    resolved = { kind: "unknown" }
    storedAddressMismatch = true
  }
  throwIfEnded()
  if (resolved.kind === "unknown") {
    const evidence = {
      credentialId: recovered.credentialId,
      pubkey: recovered.pubkey,
      addresses: deriver.addresses,
      observed,
    }
    if (!options.hints) return { entered: false, reason: "unknown", ...evidence }
    return { entered: false, reason: "unknown", ...evidence, storedAddressMismatch, verdict }
  }
  const { msk, slot } = requireResolved(resolved)
  const cancel = attemptFrom(attempt)
  // Read before `adoptRecoveredAccount` rewrites the credential's breadcrumb.
  const remembered = strict ? undefined : usertagFor(config.rpId, recovered.credentialId)

  const identity = requireVerifiedIdentity(
    await resolveOxideIdentity(generations, deriveBootstrapKey(msk).address, await deriver.derive(msk)),
  )
  throwIfEnded()
  const adopt = async () => {
    const adopted = await adoptRecoveredAccount(wallet, recovered, msk, slot, cancel, undefined, active)
    // The commit stands, but a scope that ended while the account was persisted hands nothing back:
    // no result reaches a screen the user left.
    throwIfEnded()
    return adopted
  }
  if (!identity) {
    return {
      entered: false,
      reason: "unclaimed",
      account: await adopt(),
      bootstrap: deriveBootstrapKey(msk),
      ensDomain,
    }
  }

  const account = await adopt()
  const claim: EnteredClaim = {
    nameHash: identity.nameHash.toLowerCase(),
    address: account.getAddress().toString(),
    ensDomain,
  }
  // Naming the claim: the caller-supplied handle (from the claim link) or the tag this
  // credential claimed on this browser, each verified against the on-chain nameHash — a wrong
  // or missing one confirms manually.
  const matched = (handle && tagMatches(claim, handle)) || (remembered && tagMatches(claim, remembered)) || null
  if (matched) {
    return { entered: true, handle: matched, address: claim.address, account }
  }
  return { entered: false, reason: "confirm", claim, account }
}

/** The bare form of `handle` that hashes to the entered claim's node; null when none does. */
export function tagMatches(entered: EnteredClaim, handle: string): string | null {
  return matchWireNameHash(handle, entered.ensDomain, entered.nameHash as Hex)
}

/** The bare form of `handle` that hashes to any of `nameHashes`; null when none does. */
export function reservedTagMatch(nameHashes: readonly Hex[], ensDomain: string, handle: string): string | null {
  for (const nameHash of nameHashes) {
    const matched = matchWireNameHash(handle, ensDomain, nameHash)
    if (matched) return matched
  }
  return null
}

export function confirmTag(entered: EnteredClaim, handle: string): { handle: string; address: string } {
  const matched = tagMatches(entered, handle)
  if (!matched) throw new Error(`@${handle} is not the tag this passkey claimed`)
  // The matched form is what re-hashes to the claim on every later detection tick.
  return { handle: matched, address: entered.address }
}
