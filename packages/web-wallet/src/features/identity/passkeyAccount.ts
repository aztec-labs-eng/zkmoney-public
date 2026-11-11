/**
 * A passkey's account adopted on this wallet: the key source, the ceremony behind the screen's gate,
 * the settle of the passkey's key, and the commit and save of the account it opens.
 */
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AccountEvent, AccountRecord, RecoveredCandidates } from "@obsidion/front-core"
import type { ObsidionAccount, ObsidionWallet, PrfSlot, RecoverPasskeyResult } from "@obsidion/sdk"
import { PasskeyPolicyError, type PasskeyRequestScope } from "@obsidion/passkey-web"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import type { StoredRecoveryMetadata } from "../../platform/auth/WebPasskeyIdentityMap"
import {
  type AccountPasskeys,
  type BeginRecoveryResult,
  type WebAlphaAuthService,
  type WebRecoverResult,
  isUnsettled,
} from "../../platform/auth/WebAlphaAuthService"
import { pubkeyHexFrom, type OnboardingKeys } from "../../session/account"
import { noteBackupSignIn } from "./backupSignIn"
import { GateCancelledError, type CeremonyGate } from "./ceremonyGate"
import { commitSecret, handOffAccount, type CommitScope, type Session } from "../../session/session"

/** Where a sign-in saves the account it adopted: the session's record once the commit lands. */
export type AccountsOf = () => Pick<AccountRecord, "apply">

/** What a sign-in takes: the session it starts in, and where it saves the account. */
export interface SignInDeps {
  session: CommitScope
  accounts: AccountsOf
}

/** The key an adoption commits and records: a ceremony's result, or a record the session already holds. */
export type AdoptedKey = Pick<
  WebRecoverResult,
  | "credentialId"
  | "pubkey"
  | "authProvider"
  | "passkeys"
  | "backup"
  | "backupFacts"
  | "transports"
  | "staleSet"
  | "expectedAddress"
>

/** The record an adoption writes for its key: the account `derived` under the key's set. */
export const recoveryRecord = (
  recovered: Pick<AdoptedKey, "credentialId" | "pubkey" | "passkeys" | "backup" | "transports">,
  derived: string,
  slot: PrfSlot,
): StoredRecoveryMetadata => ({
  credentialId: recovered.credentialId,
  l2Address: derived,
  pubkey: recovered.pubkey,
  prfSlot: slot,
  isMskRoot: recovered.backup === undefined,
  ...(recovered.backup ? { backup: recovered.backup } : {}),
  passkeySet: recovered.passkeys ?? [recovered.pubkey],
  authenticatorType: "platform",
  transports: recovered.transports,
})

/** The save of the account a reload's session unlocks: `account`, signed by the passkey. */
export const accountSaved = (
  account: ObsidionAccount,
  credentialId: string,
  pubkey: string,
): Extract<AccountEvent, { type: "saved" }> => ({
  type: "saved",
  completeAddress: account.getCompleteAddress().toString(),
  signer: { credentialId, pubkey, authenticatorType: "platform" },
})

/** Persist the account so a reload's session can unlock it. */
async function persistAccount(
  accounts: AccountsOf,
  account: ObsidionAccount,
  credentialId: string,
  pubkey: string,
) {
  await accounts().apply(accountSaved(account, credentialId, pubkey))
}

/**
 * Adopt a resolved candidate: record the breadcrumb against `derived`, the address the anchors
 * named, commit the MSK, then build the account on this wallet and persist its record — the shared
 * tail of every recovery flow. Only called with a candidate an anchor named. The record precedes
 * the commit so a failure after it still leaves a record the next unlock verifies against; a stale
 * record (one the chain's list moved past) is the exception, rewritten only once the session has
 * switched, since the session it was opened over proves its cache against it until then.
 * `beforeCommit` runs once the record exists and before storage moves to the new account: the last
 * moment the previous account's records can be closed where they live. The account is built only
 * after the commit, because building it installs its signer on the wallet's account for that
 * address: two keys of one account derive one address, so a backup sign-in on a browser whose root
 * session is live would otherwise re-sign the live account before the switch and leave it so when
 * the attempt is cancelled or fails. A failure past the commit is reported as committed. The
 * attempt's cancel and the caller's `stillOwns` make one ownership predicate, asked before every
 * write up to the commit and by each store under its own lock: a cancel that landed on the way
 * ends in the cancel, and nothing is written after it. Past the commit the session names this
 * account, so its record and snapshot are finished whatever the attempt did; the commit's
 * generation is the ownership from then on, asked under the session lock — where a commit
 * publishes its tuple and moves the generation in one turn — as the record is rewritten, before
 * the account is built, and as its snapshot is saved: a newer commit or a sign-out since ends the
 * work as `SessionChangedError`, with nothing written into the session that replaced it, and a
 * commit cancelled as it saved is waited out, the session put back, the work going on.
 * The build itself is not fenced: an account a newer session outran may still be registered and
 * cached on the wallet; only what names the session is. The caller gets the account with `held`,
 * the ownership it was saved under, for whatever it hands on.
 */
export async function adoptRecoveredAccount(
  wallet: ObsidionWallet,
  { session: start, accounts }: SignInDeps,
  recovered: AdoptedKey,
  msk: Fr,
  slot: PrfSlot,
  derived: string,
  attempt: AbortSignal,
  beforeCommit?: () => Promise<void>,
  stillOwns?: () => boolean,
): Promise<{ account: ObsidionAccount; held: () => boolean; session: Session }> {
  const { auth } = start
  const owns = () => !attempt.aborted && (stillOwns === undefined || stillOwns())
  const ended = () => !owns()
  if (ended()) throw new GateCancelledError()
  const writeRecord = (stillOwns?: () => boolean) =>
    auth.recordRecoveryMetadata(recoveryRecord(recovered, derived, slot), stillOwns)
  const staleRecord = recovered.staleSet !== undefined
  if (!staleRecord) {
    await writeRecord(owns)
    if (ended()) throw new GateCancelledError()
  }
  await beforeCommit?.()
  // The session switches here; a cancel that landed during the awaits above must not switch it.
  if (ended()) throw new GateCancelledError()
  // The address the page's stores were loaded for, read while that session is still the one.
  const before = await auth.sessionAddress()
  const input = { secretKey: msk, authProvider: recovered.authProvider }
  const committed = await commitSecret(start, input, owns)
  if (committed === false) throw new GateCancelledError()
  const { generation, session } = committed
  if (recovered.backupFacts) noteBackupSignIn("succeeded", recovered.backupFacts)
  // The address moved under the same key: the page's stores still hold the old one. The session's
  // own address is the evidence; the incoming record's stands in only when there was no session.
  const from = before ?? recovered.expectedAddress
  if (from !== undefined && from.toLowerCase() !== derived.toLowerCase()) auth.markRecordsStale()
  const held = () => auth.sessionHeld(generation)
  try {
    // A commit saving over this session is waited out: one cancelled as it saved put the session
    // back, and the work goes on.
    await session.sessionLock(async () => {
      if (!held()) throw new SessionChangedError()
      if (staleRecord) await writeRecord(held)
      if (!held()) throw new SessionChangedError()
    })
    const account = await wallet.createObsidionAccount(msk, recovered.authProvider)
    await session.sessionLock(async () => {
      if (!held()) throw new SessionChangedError()
      await persistAccount(accounts, account, recovered.credentialId, recovered.pubkey)
      // A sign-out that landed during the save owns the session: the snapshot stays, the account
      // reaches no caller.
      if (!held()) throw new SessionChangedError()
    })
    // A save over a record that failed to open is read by the session the hand-off opens.
    const failed = session.accountRecord?.view.get().failed
    return { account, held, session: failed ? handOffAccount(session, account) : session }
  } catch (err) {
    throw markCommitted(err)
  }
}

/**
 * The session had already switched when this error was thrown: a screen must not read it as an
 * arrival failure, and a switch to the same account moves no storage id that could tell it so.
 */
export const isCommittedFailure = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { committed?: boolean }).committed === true

export const markCommitted = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? Object.assign(err, { committed: true }) : err

/** `derive` computed once per key, and every address it produced, in derivation order. */
export function collectingDeriver(derive: (msk: Fr) => Promise<string>) {
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

/** `deriveAccountAddress` bound to the wallet and the account's key set, in the string form every anchor compares. */
export const deriveAddressWith =
  (wallet: ObsidionWallet, passkeys: readonly string[]) => async (msk: Fr) =>
    (await wallet.deriveAccountAddress(msk, passkeys)).toString()

/** The key set a settled recovery derives with: the account's when it was read, else the signer alone. */
export const keySetOf = (recovered: RecoverPasskeyResult): readonly string[] =>
  recovered.passkeys ?? [recovered.pubkey]

/** The asserted passkey derives a different account than the one the claim was started with. */
export class PasskeyMismatchError extends PasskeyPolicyError {
  constructor() {
    super("that isn't the passkey this claim was started with")
    this.name = "PasskeyMismatchError"
  }
}

/**
 * Which existing passkey to enter with: the credential to assert with. `discover` leaves the
 * browser's list open instead of naming a credential; `chooser` bypasses the cache so the user
 * picking a different passkey is never answered by a saved key.
 */
export interface PasskeyHints {
  credentialId?: string
  discover?: boolean
  chooser?: boolean
}

/**
 * Which passkey a ceremony asks for: a tag's account and its keys, a known credential, or the open
 * chooser. `discover` runs a discoverable ceremony (no credential pinned); `chooser` bypasses the
 * cache so no saved key answers; `phone` steers a laptop's prompt to the phone and bypasses the
 * cache the same way. `chosen` marks `credentialId` as the key the user picked among the account's.
 */
export type CeremonyRequest = {
  account?: AccountPasskeys
  credentialId?: string
  chosen?: boolean
  discover?: boolean
  chooser?: boolean
  phone?: boolean
}

/**
 * Where the key comes from, decided without a ceremony: the key this session already holds, or a
 * ceremony described by `request`.
 */
export type KeySource =
  | { kind: "cache"; result: WebRecoverResult }
  | { kind: "ceremony-required"; request: CeremonyRequest }

/**
 * `restore: false` consults only a key already in memory: a call answering a tap must not start
 * the cache proof on the way to the prompt.
 */
export async function resolveKeySource(
  auth: WebAlphaAuthService,
  hints?: CeremonyRequest,
  options?: { restore?: boolean },
): Promise<KeySource> {
  const request: CeremonyRequest = { ...hints }
  // The chooser and the phone are the user asking for another passkey or device, and a tag names
  // an account the answering key must prove it opens: no cached source may answer for them.
  if (request.chooser || request.phone || request.account) {
    return { kind: "ceremony-required", request }
  }
  const cached = await auth.recoverFromCache(
    options?.restore === false ? { restore: false } : undefined,
  )
  if (cached && heldKeyAnswers(cached, request)) return { kind: "cache", result: cached }
  return { kind: "ceremony-required", request }
}

/** Whether the key this session holds is the credential `request` names, or any key when it names none. */
function heldKeyAnswers(cached: WebRecoverResult, request: CeremonyRequest): boolean {
  return !request.credentialId || cached.credentialId === request.credentialId
}

/**
 * The recovery `request` describes; unsettled when this browser holds no record for the passkey.
 * `signal`, when the gate handed one out, ends the prompt on the attempt's cancel.
 */
async function ceremonyFor(
  auth: WebAlphaAuthService,
  request: CeremonyRequest,
  signal: AbortSignal | undefined,
  own?: PasskeyRequestScope,
): Promise<BeginRecoveryResult> {
  const cancel = {
    ...(signal ? { signal } : {}),
    ...(own ? { own } : {}),
    ...(request.phone ? { phone: true } : {}),
  }
  if (request.discover) return auth.beginRecovery({ discover: true, ...cancel })
  return request.account
    ? await auth.adoptAccountPasskey({ ...request.account, ...cancel })
    : await auth.beginRecovery({
        credentialId: request.credentialId,
        ...(request.chosen ? { chosen: true } : {}),
        ...cancel,
      })
}

/** A gate that hands out no attempt signal (the tests' stand-ins) gets one that never cancels. */
export const attemptFrom = (signal: AbortSignal | undefined): AbortSignal =>
  signal ?? new AbortController().signal

/**
 * The ceremony `request` describes, after the screen's gate, with the attempt the gate started.
 * `cancel` is the caller's: checked before the gate opens an attempt and again before the prompt,
 * so a cancel during the reads that precede it starts nothing. A cancel past that point is the
 * screen's to hand to the gate, whose attempt the ceremony runs under; every write behind the
 * prompt asks the caller's cancel as well, through the ownership predicate each flow builds.
 */
export async function ceremonyPath(
  auth: WebAlphaAuthService,
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
    return { recovered: await ceremonyFor(auth, request, signal, own), attempt }
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
  auth: WebAlphaAuthService,
  hints: CeremonyRequest | undefined,
  gate: CeremonyGate,
  cancel?: AbortSignal,
  own?: PasskeyRequestScope,
): Promise<{ recovered: BeginRecoveryResult; attempt?: AbortSignal }> {
  const source = await resolveKeySource(auth, hints)
  if (source.kind !== "ceremony-required") return { recovered: source.result, attempt: cancel }
  return ceremonyPath(auth, source.request, gate, cancel, own)
}

const throwIfCancelled = (attempt: AbortSignal) => {
  if (attempt.aborted) throw new GateCancelledError()
}

/** A signing key the L1 read settled, with every key of the account that installed it. */
export interface InstalledKey {
  pubkeyHex: string
  passkeys: readonly string[]
}

/**
 * Settle a recovery's public key before the master key is resolved: the address depends on both,
 * so the key comes first. `installed`, the key the sign-in's L1 accounts installed at registration
 * with that account's key set, settles without a prompt; otherwise the passkey is asked a second
 * time, behind the gate so the user taps before a prompt that would otherwise open seconds after
 * the last one. The attempt's cancel is checked before every step this adds; nothing here writes.
 */
export async function settleRecovery(
  recovered: BeginRecoveryResult,
  gate: CeremonyGate,
  attempt: AbortSignal = attemptFrom(undefined),
  installed?: InstalledKey,
): Promise<WebRecoverResult> {
  if (!isUnsettled(recovered)) return recovered
  throwIfCancelled(attempt)
  if (installed) return recovered.settle(installed.pubkeyHex, undefined, installed.passkeys)
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
  // caller. A scope cancelled, or a session replaced, in that window (a modal closed, the gate
  // cancelled, a newer commit), before or during the key read, stops here, so no sweep or pending
  // step runs against a session the user walked away from.
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
 * cancel — a closed sheet — and ends the adoption anywhere before the commit, prompt or no prompt;
 * past the commit the account is still built and saved, and the keys reach only a scope still open
 * over the session that saved them.
 */
export async function reusePasskeyAccount(
  wallet: ObsidionWallet,
  signIn: SignInDeps,
  expectedL2Address: string,
  hints: PasskeyHints | undefined,
  gate: CeremonyGate,
  signal?: AbortSignal,
  own?: PasskeyRequestScope,
): Promise<OnboardingKeys> {
  const { recovered, attempt } = await keyMaterial(signIn.session.auth, hints, gate, signal, own)
  // The attempt owns the prompt; the caller's cancel owns everything after it.
  const owns = () => !attempt?.aborted && !signal?.aborted
  const settled = await settleRecovery(recovered, gate, attempt)
  if (!owns()) throw new GateCancelledError()
  const deriver = collectingDeriver(deriveAddressWith(wallet, keySetOf(settled)))
  const picked = await candidateDeriving(settled, expectedL2Address, deriver.derive)
  if (!picked) throw new PasskeyMismatchError()
  const { account, held } = await adoptRecoveredAccount(
    wallet,
    signIn,
    settled,
    picked.msk,
    picked.slot,
    await deriver.derive(picked.msk),
    attemptFrom(attempt),
    undefined,
    owns,
  )
  return keysFor(account, settled, picked.msk, () => owns() && held())
}
