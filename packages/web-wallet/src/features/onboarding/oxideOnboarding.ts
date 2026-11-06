/**
 * Web glue for the onboarding rails, over shared front-core primitives
 * (`startOxideRegistrationSession`, `resolveTagViaRegistry`): the gasless L1 NameClaim
 * (account-service), the ClaimFPC eligibility witness every sponsored rail batches its
 * subscription with, and the returning-user recovery flows (reuse a passkey for a new
 * tag; fresh-device enter via on-chain lookup). Fresh passkey-account creation runs
 * through front-core's `createAccount`.
 *
 * Onboarding's account-service gate accepts a synthetic keyId against an `IS_TEST_MODE`
 * deployment (sandbox, the e2e); a real deployment still needs a credential provider wired
 * into `claimTag`'s `AccountServiceClient` before its gated routes will pass (tracked
 * alongside the registration-by-deposit rewrite — see docs/proposals/registration-fee-plan.md).
 */
import { refundedEntry } from "../registration/admission"
import { assertEarnedQuote } from "../registration/earnedQuote"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { Hex } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import {
  composeWireNameHash,
  matchWireNameHash,
  createOxideL1Reader,
  deriveBootstrapKey,
  readInstalledPasskeyKey,
  requireVerifiedIdentity,
  resolveOxideIdentity,
  resolveRecoveredMsk,
  startOxideRegistrationSession,
  StoredAddressMismatchError,
  type AnchorTier,
  type PendingRegistrationRecord,
  type NameTakenReason,
  type OxideL1Reader,
  UnverifiedOxideIdentityError,
  type ResolvedMsk,
  type OxideRegistrationSessionDeps,
  type OxideRegistrationStage,
  goldenTicketCoverage,
  type NameClaims,
  type RegistrationRecovery,
  type RegistrationRoute,
  type RegistrationStore,
  type RegistrationTerms,
} from "@obsidion/front-core"
import { activeWithdrawalFee } from "../withdraw/withdrawalFee"
import type { NameClaimResponse, RegistrationSchedule } from "@obsidion/core/types"
import { WalletError, bestEffort } from "@obsidion/core/errors"
import {
  claimTerms,
  wireTermsFundLink,
  wireTermsFundTicket,
} from "../registration/registrationTerms"
import { linkIdentity } from "../paylink/linkIdentity"
import { updateTicketSignup, type TicketSignupStash } from "../paylink/claimStash"
import { redeemGoldenTicketForLink } from "./goldenTicket"
import type { RegistrationPayloads } from "../broadcasts/registrationExecutor"
import type { ContractService, ObsidionWallet, ObsidionAccount } from "@obsidion/sdk"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { getConfig, type WebWalletConfig } from "../../config/env"
import {
  AmbiguousPasskeyError,
  type PasskeyRequestScope,
  currentDevicePosture,
} from "@obsidion/passkey-web"
import { GateCancelledError, type CeremonyGate } from "../identity/ceremonyGate"
import {
  PasskeyMismatchError,
  adoptRecoveredAccount,
  attemptFrom,
  ceremonyPath,
  collectingDeriver,
  deriveAddressWith,
  keySetOf,
  resolveKeySource,
  settleRecovery,
  type AccountsOf,
  type CeremonyRequest,
  type InstalledKey,
} from "../identity/passkeyAccount"
import type { OnboardingKeys } from "../../session/account"
import type { Session } from "../../session/session"
import { accountServiceFor, registrationSessionDeps } from "../registration/registrationDeps"
import {
  type AccountPasskeys,
  type BeginRecoveryResult,
  HintedKeyMismatchError,
  type MismatchVerdict,
  type Observation,
  type UnsettledRecovery,
  type WebAlphaAuthService,
  isUnsettled,
} from "../../platform/auth/WebAlphaAuthService"
import { usertagFor } from "../../platform/auth/WebPasskeyIdentityMap"
import { enterTiers, requireResolved } from "./recoveryProbes"
import { generationAddresses } from "../registration/generationAddresses"
import { generationFactories, loadOxideGenerations } from "../registration/oxideGenerations"
import { resolveTagForCommit } from "../contacts/registryResolution"

import { attributeInboundInvite } from "../invite/inboundInvite"

export type ClaimStatus = "reserved" | "claimed"

export type EnterResult =
  | {
      entered: true
      handle: string
      address: string
      account: ObsidionAccount
      /** Whether the session the account was saved under is still this page's: a sign-out or a
       *  newer commit since ends it, and nothing after installs the account. */
      held: () => boolean
    }
  /** The passkey's predicted account has no Registry record: a nameless account, or onboarding
   *  died before the claim. The caller decides — nameless re-entry needs the recovered account
   *  and the bootstrap key for the admission check. */
  | {
      entered: false
      reason: "unclaimed"
      account: ObsidionAccount
      held: () => boolean
      /** The session the sign-in's commit made current. */
      own: Session
      bootstrap: PrivateKeyAccount
      /** The wire domain a claimed tag hashes under, to name a reservation the caller finds. */
      ensDomain: string
      /** The tag this credential claimed on this browser; tried before `userHandle`. */
      usertag?: string
      /** The name the passkey carries, to name that reservation without asking. */
      userHandle?: string
    }
  /** Claim found; the plaintext tag is needed to name it (hash-only on-chain). */
  | {
      entered: false
      reason: "confirm"
      claim: EnteredClaim
      account: ObsidionAccount
      held: () => boolean
    }
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
      /** The retired-rollup list failed to load, so no account was ruled out. */
      catalogIncomplete?: boolean
    }

/** The recovered on-chain claim, pending a plaintext tag to name it. */
export interface EnteredClaim {
  nameHash: string
  address: string
  ensDomain: string
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

/**
 * The passkey's account holds more keys than the sign-in could read, so its address cannot be
 * derived; the tag-first sign-in reads the set in full.
 */
export class PasskeySetUnreadError extends Error {
  constructor() {
    super(
      "This passkey's account has more passkeys than this sign-in could read. Sign in with your @tag.",
    )
    this.name = "PasskeySetUnreadError"
  }
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
 * two possible keys within the budget, with that account's whole key set; `undefined` when none
 * does, or the read times out or fails, and the passkey is asked again. Several holding accounts
 * end the attempt as ambiguous, and a holding account whose set could not be read in full ends it
 * as unread, both before any second prompt. A cancel is reported by the caller's own check.
 */
async function installedKeyFor(
  recovered: UnsettledRecovery,
  l1: OxideL1Reader,
  registry: Hex,
  accountFactories: readonly Hex[],
  cancels: readonly AbortSignal[],
): Promise<InstalledKey | undefined> {
  const masterKeys = [recovered.candidates.first, recovered.candidates.second].filter(
    (msk): msk is Fr => msk !== undefined,
  )
  const outcome = await withinBudget(
    (stop) =>
      readInstalledPasskeyKey(masterKeys, recovered.pubkeyCandidates, {
        reader: l1,
        registry,
        accountFactories,
        stop,
      }),
    INSTALLED_KEY_BUDGET_MS,
    cancels,
  )
  if (outcome.kind === "value") {
    const read = outcome.value
    if (read.kind === "found") return { pubkeyHex: read.pubkeyHex, passkeys: read.passkeys }
    if (read.kind === "ambiguous") throw new AmbiguousPasskeyError()
    if (read.kind === "incomplete") throw new PasskeySetUnreadError()
    return undefined
  }
  // The error's text can carry the RPC URL, so only its class is logged.
  if (outcome.kind === "timeout") {
    console.warn("[oxideOnboarding] installed passkey key: timeout; asking the passkey again")
  } else if (outcome.kind === "read-failed") {
    const name = outcome.error instanceof Error ? outcome.error.name : "unknown"
    console.warn(
      `[oxideOnboarding] installed passkey key: read-failed (${name}); asking the passkey again`,
    )
  }
  return undefined
}

/**
 * What a sign-in is pinned to: a tag's account and its keys, or a credential this browser remembers.
 * `chosen`: the user picked this credential among its account's keys.
 */
export type SignInHints = AccountPasskeys | { credentialId: string; chosen?: boolean }

const isAccountHints = (hints: SignInHints): hints is AccountPasskeys => "keys" in hints

/**
 * The request a sign-in makes: pinned to the hinted account or credential on any posture, else
 * discoverable on a laptop (its own account chooser lists whatever holds the passkey — this
 * computer, a phone, a key) or for the chooser, else the phone's own pin straight to the biometric.
 */
function signInRequest(options: {
  chooser?: boolean
  hints?: SignInHints
  phone?: boolean
}): CeremonyRequest | undefined {
  const phone = options.phone ? { phone: true } : {}
  if (options.hints) {
    if (isAccountHints(options.hints)) return { account: options.hints, ...phone }
    const { credentialId, chosen } = options.hints
    return { credentialId, ...(chosen ? { chosen } : {}), ...phone }
  }
  if (options.chooser || currentDevicePosture() === "laptop") {
    return { discover: true, ...(options.chooser ? { chooser: true } : {}), ...phone }
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
  auth: WebAlphaAuthService
  gate: CeremonyGate
  chooser?: boolean
  phone?: boolean
  hints?: SignInHints
  signal?: AbortSignal
  cacheOnly?: boolean
  restoreCache?: boolean
  own?: PasskeyRequestScope
}): Promise<{ recovered: BeginRecoveryResult; attempt?: AbortSignal } | undefined> {
  const request = signInRequest(options)
  try {
    const source = await resolveKeySource(options.auth, request, { restore: options.restoreCache })
    if (source.kind !== "ceremony-required") {
      return { recovered: source.result, attempt: options.signal }
    }
    if (options.cacheOnly) return undefined
    return await ceremonyPath(
      options.auth,
      source.request,
      options.gate,
      options.signal,
      options.own,
    )
  } catch (err) {
    if (err instanceof HintedKeyMismatchError) throw new PasskeyMismatchError()
    throw err
  }
}

/**
 * `custody` means onboarding may complete: the registration is confirmed on-chain. The deferred
 * setup recovers the claim witness from the Registry's `NameClaimed` log, never from this session.
 * `pending` is resumable, never a failure — the durable record carries the state, and the UI shows
 * in-progress copy.
 */
export type ClaimTagOutcome =
  | { kind: "custody"; confirmed: true; oxideAccount: string }
  /** `claim` is the fresh NameClaim (+ optional fee waiver) the deposit screen renders — in memory
   *  only, same as the session result it comes from; a resumed record has no claim to show. */
  | {
      kind: "pending"
      oxideAccount: string
      claim: NameClaimResponse
      /** The network paused paylink tickets before this signup's was redeemed; `claim.terms` say
       *  whether one redeemed earlier still priced it. */
      ticketUnavailable?: true
      /** The stashed link funds the signed deposit: its claim on Home pays the registration. */
      depositLink?: LinkDeposit
    }

/**
 * The link's note covers the ticket burn on the advertised ticket schedule and the executor's fee, with no prover tip:
 * registration does not need one, so gas never fails a link here. An unadvertised schedule prices
 * nothing, and nothing is spent on a guess.
 */
export function linkCoversTicketBurn(
  amount: bigint,
  advertised: RegistrationSchedule | undefined,
  withdrawalFee: bigint,
): boolean {
  if (!advertised) return false
  return goldenTicketCoverage(amount, advertised, 0n, withdrawalFee).covers
}

/** How a ticket-funded signup's redemption went before its claim was signed. */
export type TicketRedemption = "none" | "redeemed" | "unavailable"

/** The registration session's stages, plus a ticket signup's proof and the NameClaim after it. */
export type SignupStage = OxideRegistrationStage | "ticket_prove" | "reserve"

export const isRegistrationStage = (stage: SignupStage): stage is OxideRegistrationStage =>
  stage === "derive" || stage === "claim" || stage === "broadcast"

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
  onProving?: () => void,
): Promise<TicketRedemption> {
  if (!ticket) return "none"
  if (!wallet) throw new WalletError("wallet.notReady")
  const outcome = await redeemGoldenTicketForLink({
    wallet,
    accountService: accountServiceFor(config, keys),
    secretKey: keys.secretKey,
    fragment: ticket.fragment,
    covers: async (amount, advertised) =>
      linkCoversTicketBurn(amount, advertised, await activeWithdrawalFee()),
    onProving,
  })
  if (outcome.amount !== undefined) updateTicketSignup({ amount: outcome.amount.toString() })
  switch (outcome.status) {
    case "unavailable":
      return "unavailable"
    case "below_threshold":
      throw new WalletError("registration.ticketBelowThreshold")
    case "cannot_cover":
      throw new WalletError("registration.ticketCannotCover")
  }
  return "redeemed"
}

/**
 * What a registration checkpoint makes durable beside its record: the quote, and the link whose
 * ticket the quote honours. A reopen finds the registration this link funds by that identity, and
 * never proves or claims again for it.
 */
export function checkpointRegistrationTerms(
  claim: NameClaimResponse,
  opts: {
    earnedExpected: boolean
    ticket: TicketSignupStash | null
    /** The link, when its note covers these terms' deposit (`linkCoversDeposit`). */
    depositLink?: LinkDeposit
  },
): RegistrationTerms {
  const ticket = opts.ticket && wireTermsFundTicket(claim.terms) ? opts.ticket : null
  return {
    ...claimTerms(claim),
    ...(opts.earnedExpected ? { earnedExpected: true } : {}),
    ...(ticket
      ? {
          paylinkFunded: true,
          paylinkId: linkIdentity(ticket.fragment),
          ...(ticket.amount !== undefined ? { paylinkAmount: ticket.amount } : {}),
          ...(ticket.senderTag ? { paylinkSender: ticket.senderTag } : {}),
          ...(ticket.proverTip !== undefined ? { proverTip: ticket.proverTip } : {}),
          ...(ticket.speed !== undefined ? { speed: ticket.speed } : {}),
        }
      : opts.depositLink
      ? {
          paylinkFunded: true,
          paylinkId: linkIdentity(opts.depositLink.fragment),
          paylinkDeposit: true,
          paylinkAmount: opts.depositLink.amount.toString(),
          ...(opts.depositLink.senderTag ? { paylinkSender: opts.depositLink.senderTag } : {}),
          proverTip: opts.depositLink.proverTip.toString(),
          ...(opts.depositLink.speed ? { speed: opts.depositLink.speed } : {}),
        }
      : {}),
  }
}

/** A link with no ticket for this signup, which pays the name's own deposit when it covers it. */
export interface LinkDeposit {
  fragment: string
  /** The note, base units. */
  amount: bigint
  /** The prover tip the split committed, base units, and the speed with it. */
  proverTip: bigint
  speed?: "standard" | "faster"
  /** The link creator's verified tag. */
  senderTag?: string
}

/**
 * The note covers the signed deposit, the executor's fee and the committed prover tip with something
 * left: the rule a ticket's burn is held to. Unpriced terms or an unread fee cover nothing.
 */
export async function linkCoversDeposit(
  link: LinkDeposit,
  terms: NameClaimResponse["terms"],
  readWithdrawalFee: () => Promise<bigint> = activeWithdrawalFee,
): Promise<boolean> {
  if (!terms || !wireTermsFundLink(terms)) return false
  const withdrawalFee = await bestEffort("unknown", readWithdrawalFee())
  if (withdrawalFee === undefined) return false
  const schedule = { fee: BigInt(terms.fee), min: BigInt(terms.minDeposit) }
  return goldenTicketCoverage(link.amount, schedule, link.proverTip, withdrawalFee).covers
}

/** The session a claim registers in. */
export type ClaimSession = Pick<
  Session,
  | "registrations"
  | "sipaDeposits"
  | "nameClaims"
  | "registrationRecovery"
  | "registrationPayloads"
  | "accountRecord"
  | "signup"
>

/** `claimWith` over this browser's account service, chain reads and ticket. */
export function claimTag(
  own: ClaimSession,
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet: ObsidionWallet,
  onStage?: (stage: SignupStage) => void,
  requireEarnedQuote = false,
  refundedRecord?: PendingRegistrationRecord,
  replacedRecord?: PendingRegistrationRecord,
  ticket: TicketSignupStash | null = null,
  linkDeposit?: LinkDeposit,
  route?: RegistrationRoute,
): Promise<ClaimTagOutcome> {
  const deps: ClaimDeps = {
    registrations: own.registrations,
    nameClaims: own.nameClaims,
    recovery: own.registrationRecovery,
    payloads: own.registrationPayloads,
    sessionDeps: async (stage) => {
      // Settled before anything registers: account-service refuses an invitee who already is.
      await attributeInboundInvite(accountServiceFor(config, keys))
      return registrationSessionDeps(handle, keys, config, wallet.networkId, own, stage)
    },
    redeemTicket: (onProving) => redeemLinkedGoldenTicket(keys, config, wallet, ticket, onProving),
    withdrawalFee: activeWithdrawalFee,
  }
  const request = { handle, keys, onStage, requireEarnedQuote, refundedRecord, replacedRecord }
  return claimWith(deps, { ...request, ticket, linkDeposit, route })
}

/** A claim on a chosen name over the registration still owed its deposit. */
export const claimChosenName =
  (own: ClaimSession, wallet: ObsidionWallet, earned: boolean, route: RegistrationRoute) =>
  (tag: string, keys: OnboardingKeys, replaced: PendingRegistrationRecord) =>
    claimTag(
      own,
      tag,
      keys,
      getConfig(),
      wallet,
      undefined,
      earned,
      undefined,
      replaced,
      null,
      undefined,
      route,
    )

/** What a claim reads and writes beside its request. */
export interface ClaimDeps {
  registrations: Pick<RegistrationStore, "apply">
  nameClaims: Pick<NameClaims, "put">
  recovery: Pick<RegistrationRecovery, "assertRefunded" | "assertUnfunded" | "reopen">
  /** Where the session's own payload waits for the address's first broadcast. */
  payloads: RegistrationPayloads
  /** The registration session's deps, built once any inbound invite is settled. */
  sessionDeps(
    onStage?: (stage: OxideRegistrationStage) => void,
  ): Promise<OxideRegistrationSessionDeps>
  /** Redeems the signup's ticket, if it carries one. */
  redeemTicket(onProving: () => void): Promise<TicketRedemption>
  withdrawalFee(): Promise<bigint>
}

export interface ClaimRequest {
  handle: string
  keys: Pick<OnboardingKeys, "account">
  onStage?: (stage: SignupStage) => void
  requireEarnedQuote?: boolean
  refundedRecord?: PendingRegistrationRecord
  replacedRecord?: PendingRegistrationRecord
  ticket: TicketSignupStash | null
  linkDeposit?: LinkDeposit
  route?: RegistrationRoute
}

/**
 * Claims `handle`: a refunded or replaced record's checks, the ticket, then the registration
 * session, whose checkpoint closes the old record.
 */
export async function claimWith(deps: ClaimDeps, request: ClaimRequest): Promise<ClaimTagOutcome> {
  const { handle, keys, onStage, requireEarnedQuote = false, refundedRecord } = request
  const { replacedRecord, ticket, linkDeposit, route } = request
  let ticketUnavailable = false
  let entry: PendingRegistrationRecord["refundedEntry"]
  if (refundedRecord) {
    if (
      handle !== refundedRecord.tag ||
      keys.account.getAddress().toString() !== refundedRecord.l2Address
    ) {
      throw new WalletError("registration.restartWrongWallet")
    }
    const refund = await deps.recovery.assertRefunded(refundedRecord)
    entry = refundedEntry(refundedRecord, refund)
  }
  const session = await deps.sessionDeps(onStage)
  // Entry rides on the replacement record from its checkpoint: the receipt a sign-out clears cannot
  // be rebuilt from an address that holds nothing, and a session that dies after the checkpoint
  // must not lose it.
  if (entry) session.refundedEntry = entry
  const prior = refundedRecord ?? replacedRecord
  if (prior) {
    // The checkpoint closes the old record as replaced, and a deposit reaching its address later is
    // recovered off it. The old address spent the account's one-shot broadcast only if it recorded
    // one, or inherited that: a refund moves L1 funds and says nothing about it.
    session.replaced = {
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
    const derive = session.deriveRegistrationSipa
    session.deriveRegistrationSipa = async (args) => {
      const result = await derive(args)
      await deps.recovery.assertRefunded(refundedRecord)
      const reentry = sameAddress(result.sipaAddress)
      if (
        args.owner.toLowerCase() !== refundedRecord.account.toLowerCase() ||
        (reentry && (refundedRecord.fee === undefined || args.fee !== BigInt(refundedRecord.fee)))
      ) {
        throw new WalletError("registration.earnedSameAddress")
      }
      if (reentry) {
        // The refund emptied the address; entry stays on the record.
        if (entry && !refundedRecord.refundedEntry) {
          await deps.registrations.apply(refundedRecord.sipaAddress, {
            type: "refunded",
            txHash: entry.recoveryTxHash,
            entry,
          })
        }
        await deps.recovery.reopen(refundedRecord)
      }
      return result
    }
  }
  if (replacedRecord && !refundedRecord) {
    const derive = session.deriveRegistrationSipa
    session.deriveRegistrationSipa = async (args) => {
      const result = await derive(args)
      // A deposit landing at the old address during the quote fetch would be stranded once the
      // checkpoint overwrites its record. Re-check emptiness here, right before that write: a
      // funded old address aborts the replace and keeps its recoverable record instead.
      await deps.recovery.assertUnfunded(replacedRecord)
      return result
    }
  }
  let depositLink: LinkDeposit | undefined
  const accountService = session.accountService
  session.accountService = {
    signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
      // The session checks the name and account on L1 before requesting terms. Redeeming here
      // avoids spending a ticket on an account that already owns a name or on a taken name.
      ticketUnavailable =
        (await deps.redeemTicket(() => onStage?.("ticket_prove"))) === "unavailable"
      if (ticket) onStage?.("reserve")
      const claim = await accountService.signDomain(...args)
      if (requireEarnedQuote || refundedRecord) assertEarnedQuote(claim.terms)
      if (linkDeposit && (await linkCoversDeposit(linkDeposit, claim.terms, deps.withdrawalFee)))
        depositLink = linkDeposit
      return claim
    },
  }
  // The quote goes durable with the record, in the write that creates it.
  session.termsOf = (claim) =>
    checkpointRegistrationTerms(claim, {
      earnedExpected: requireEarnedQuote,
      ticket,
      depositLink,
    })
  if (route) session.route = route
  const result = await startOxideRegistrationSession(session)
  switch (result.status) {
    case "taken":
      throw new NameTakenError(result.reason, handle)
    case "already_registered":
      throw result.name
        ? new WalletError("onboarding.alreadyClaimed", undefined, { data: { name: result.name } })
        : new WalletError("onboarding.alreadyClaimedOther")
    case "registered":
      return { kind: "custody", confirmed: true, oxideAccount: result.oxideAccount }
    // awaiting_deposit: the deposit address is derived + the claim is in hand; the sender must fund
    // it before the name registers. Presented as pending — the onboarding screen's deposit panel
    // shows the address + claim, and the detection task confirms once the relayer sweeps.
    case "awaiting_deposit": {
      // A manual sweep needs the claim cached, and this session's own broadcast may never cache it.
      if (prior) {
        await deps.nameClaims.put({
          address: prior.l2Address,
          handle,
          nameHash: prior.nameHash,
          signature: result.claim.signature,
          nonce: result.claim.nonce,
          deadline: result.claim.deadline,
          terms: result.claim.terms,
        })
      }
      // The sheet that shows the address owes its broadcast; the first attempt reuses this payload.
      if (result.broadcastOwed) deps.payloads.set(result.sipaAddress.toLowerCase(), result.payload)
      return {
        kind: "pending",
        oxideAccount: result.oxideAccount,
        claim: result.claim,
        ...(ticketUnavailable ? { ticketUnavailable: true as const } : {}),
        ...(depositLink ? { depositLink } : {}),
      }
    }
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
 * `hints` names either a remembered credential, which pins the ceremony to it on any posture, or
 * the tag's L1 account with its keys: the sheet is then held to the credential ids the keys name
 * (a root's raw id, a backup's id behind its envelope). Either way the answering key is checked
 * against the signature, never trusted, and the anchors decide as always. `strictTag` (implied by
 * `hints`) lets only `handle` name the claim.
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
    auth: WebAlphaAuthService
    contractService: ContractService
    accounts: AccountsOf
    tiers?: AnchorTier[]
    grantToken?: string
    gate: CeremonyGate
    chooser?: boolean
    /** Steer a laptop's prompt to the phone, the wrong-key card's way on. */
    phone?: boolean
    hints?: SignInHints
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
  void bestEffort("unknown", generationsRead)

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
  let installedKey: InstalledKey | undefined
  if (isUnsettled(begun)) {
    throwIfEnded()
    const cancels = [options.signal, attempt].filter((s): s is AbortSignal => s !== undefined)
    installedKey = await installedKeyFor(
      begun,
      l1,
      generations.registry,
      generationFactories(generations),
      cancels,
    )
    throwIfEnded()
  }
  const recovered = await settleRecovery(begun, options.gate, attemptFrom(attempt), installedKey)
  throwIfEnded()
  const deriver = collectingDeriver(deriveAddressWith(wallet, keySetOf(recovered)))
  const addressesFor = generationAddresses(config, recovered.pubkey)
  // A record the chain's list has moved past still picks the key, by the set it was written with;
  // the entry then derives under the chain's set and rewrites the record to it.
  const anchorDerive = recovered.staleSet
    ? deriveAddressWith(wallet, recovered.staleSet)
    : deriver.derive
  const { observed } = recovered
  const { auth } = options
  let resolved: ResolvedMsk
  let storedAddressMismatch = false
  let verdict: MismatchVerdict | undefined
  try {
    const grantToken = handle ? options.grantToken : undefined
    const grant =
      grantToken && handle
        ? { nameHash: composeWireNameHash(handle, ensDomain), token: grantToken }
        : undefined
    resolved = await resolveRecoveredMsk(
      recovered,
      anchorDerive,
      options.tiers ?? enterTiers(config, generations, grant, addressesFor),
    )
  } catch (err) {
    // This browser's own record for the credential no longer reproduces from the passkey.
    if (!(err instanceof StoredAddressMismatchError)) throw err
    verdict = auth.mismatchVerdict(recovered)
    // The plain path shows the card from the thrown error; the hinted path from the result.
    if (!options.hints) throw Object.assign(err, { verdict, observed })
    resolved = { kind: "unknown" }
    storedAddressMismatch = true
  }
  throwIfEnded()
  const evidence = () => ({
    credentialId: recovered.credentialId,
    pubkey: recovered.pubkey,
    addresses: deriver.addresses,
    observed,
    ...(generations.catalogIncomplete ? { catalogIncomplete: true } : {}),
  })
  if (resolved.kind === "unknown") {
    if (!options.hints) return { entered: false, reason: "unknown", ...evidence() }
    return { entered: false, reason: "unknown", ...evidence(), storedAddressMismatch, verdict }
  }
  const { msk, slot } = requireResolved(resolved)
  const cancel = attemptFrom(attempt)
  // Read before `adoptRecoveredAccount` rewrites the credential's breadcrumb.
  const remembered = strict
    ? undefined
    : usertagFor(options.auth.device.get().passkeyMap, config.rpId, recovered.credentialId) ??
      recovered.usertag

  const derived = await deriver.derive(msk)
  let identity: ReturnType<typeof requireVerifiedIdentity>
  try {
    identity = requireVerifiedIdentity(
      await resolveOxideIdentity(
        generations,
        deriveBootstrapKey(msk).address,
        derived,
        addressesFor(msk, derived),
      ),
    )
  } catch (err) {
    // The key was settled by the passkey, not by the account's key set: an account with more keys
    // derives an address the key alone cannot, so the tag-first sign-in is the way in.
    const setUnread = isUnsettled(begun) && installedKey === undefined
    if (err instanceof UnverifiedOxideIdentityError && setUnread) throw new PasskeySetUnreadError()
    throw err
  }
  throwIfEnded()
  // A tag named the account: the key must open that account and no other. Nothing is written for
  // an account the registry does not name, or for any account but the one the tag resolved to; the
  // name the registry holds for it now is the claim's, confirmed below when it is not the tag.
  const pinned = options.hints && isAccountHints(options.hints) ? options.hints.account : undefined
  if (pinned && (!identity || identity.account.toLowerCase() !== pinned.toLowerCase())) {
    return { entered: false, reason: "unknown", ...evidence(), storedAddressMismatch, verdict }
  }
  const adopt = async () => {
    const adopted = await adoptRecoveredAccount(
      wallet,
      { auth, accounts: options.accounts },
      recovered,
      msk,
      slot,
      derived,
      cancel,
      undefined,
      active,
    )
    // The commit stands, but a scope that ended while the account was persisted hands nothing back:
    // no result reaches a screen the user left.
    throwIfEnded()
    return adopted
  }
  if (!identity) {
    return {
      entered: false,
      reason: "unclaimed",
      ...(await adopt()),
      bootstrap: deriveBootstrapKey(msk),
      ensDomain,
      ...(remembered ? { usertag: remembered } : {}),
      ...(recovered.userHandle ? { userHandle: recovered.userHandle } : {}),
    }
  }

  const { account, held } = await adopt()
  const claim: EnteredClaim = {
    nameHash: identity.nameHash.toLowerCase(),
    address: account.getAddress().toString(),
    ensDomain,
  }
  // Naming the claim: the caller-supplied handle (from the claim link), the tag this credential
  // claimed on this browser, or the name the passkey itself carries, each verified against the
  // on-chain nameHash — none that matches confirms manually.
  const carried = strict ? undefined : recovered.userHandle
  const matched =
    (handle && tagMatches(claim, handle)) ||
    (remembered && tagMatches(claim, remembered)) ||
    (carried && tagMatches(claim, carried)) ||
    null
  if (matched) {
    return { entered: true, handle: matched, address: claim.address, account, held }
  }
  return { entered: false, reason: "confirm", claim, account, held }
}

/** The bare form of `handle` that hashes to the entered claim's node; null when none does. */
export function tagMatches(entered: EnteredClaim, handle: string): string | null {
  return matchWireNameHash(handle, entered.ensDomain, entered.nameHash as Hex)
}

/** The bare form of `handle` that hashes to any of `nameHashes`; null when none does. */
export function reservedTagMatch(
  nameHashes: readonly Hex[],
  ensDomain: string,
  handle: string,
): string | null {
  for (const nameHash of nameHashes) {
    const matched = matchWireNameHash(handle, ensDomain, nameHash)
    if (matched) return matched
  }
  return null
}

export function confirmTag(
  entered: EnteredClaim,
  handle: string,
): { handle: string; address: string } {
  const matched = tagMatches(entered, handle)
  if (!matched) throw new WalletError("onboarding.tagMismatch", undefined, { data: { handle } })
  // The matched form is what re-hashes to the claim on every later detection tick.
  return { handle: matched, address: entered.address }
}
