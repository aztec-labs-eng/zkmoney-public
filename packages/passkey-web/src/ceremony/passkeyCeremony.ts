/**
 * Thin WebAuthn ceremony seam. `BrowserPasskeyCeremony` is the only module
 * that touches `navigator.credentials`; everything above it (the drivers,
 * signing, pubkey recovery) takes the interface so unit tests can inject a
 * fake and Playwright exercises the real one.
 */

import { RelatedOriginPasskeyError, markPasskeyWritten } from "../policy/passkeyErrors.js"
import { encodeUserHandle } from "./userHandle.js"
import { isRpDomainSuffix } from "../policy/relyingParty.js"
import { iosBelowFloor, parseUserAgent } from "../policy/userAgentInfo.js"
import { authDataFromAttestation, p256FromAuthData, p256FromSpki } from "./attestation.js"
import {
  parseAaguid,
  parseAttestedAaguid,
  parseAuthenticatorDataFlags,
} from "./authenticatorData.js"
import { base64UrlToBytes } from "./bytes.js"

/**
 * WebAuthn and Web Locks present at all — absent on old or locked-down browsers. The session store
 * serializes its writes across tabs with a Web Lock, so a browser without one is unsupported.
 */
export const passkeysSupported = () =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined" &&
  typeof (navigator as Navigator & { locks?: LockManager }).locks?.request === "function"

/** The authenticator class the browser reports on a completed ceremony. */
export type PasskeyAttachment = "platform" | "cross-platform"

/** WebAuthn Level 3 UI hints — advisory steering for the browser sheet, never enforcement. */
export type PasskeyHint = "hybrid" | "client-device" | "security-key"

export type PasskeyCreateRequest = {
  rpId: string
  rpName: string
  userName: string
  /** Which authenticator class to ask for; the response's attachment is what the caller checks. */
  authenticatorAttachment?: PasskeyAttachment
  hints?: readonly PasskeyHint[]
  /** PRF `eval.first` salt — the browser applies K(·) itself before the authenticator sees it. */
  prfFirstSalt: Uint8Array
  /** PRF `eval.second` salt, evaluated in the same ceremony. */
  prfSecondSalt?: Uint8Array
}

export type PasskeyCreateResult = {
  credentialId: string // base64url
  pubkey: Uint8Array // 64 bytes, x||y
  prfFirst?: Uint8Array
  prfSecond?: Uint8Array
  authenticatorAttachment?: PasskeyAttachment
  /** Undefined when the response carried no readable authenticator data. */
  backupEligible?: boolean
  /** The provider's self-reported id (hyphenated uuid); undefined when absent or all zeros. */
  aaguid?: string
  /**
   * The transports the client believes this authenticator supports, as it reported them. Undefined
   * when the browser offers no answer; the policy layer decides what a given list means. Always
   * present as a key, so a result that carries no transports at all (an assertion) is a type error
   * where the class is decided.
   */
  transports: readonly string[] | undefined
}

export type PasskeyAssertRequest = {
  rpId: string
  challenge: Uint8Array
  /** Constrain the OS sheet to these credentials (base64url ids). */
  credentialIds?: string[]
  /**
   * Transports recorded for those credentials when they were created. The browser offers the
   * authenticators they name, so a sign-in reaches the phone or the key without going through a
   * list of everything it could try.
   */
  transports?: readonly string[]
  hints?: readonly PasskeyHint[]
  prfFirstSalt?: Uint8Array
  prfSecondSalt?: Uint8Array
  /** Ends the ceremony: the browser's sheet closes, and no queued or retried request follows. */
  signal?: AbortSignal
}

export type PasskeyAssertResult = {
  credentialId: string
  prfFirst?: Uint8Array
  prfSecond?: Uint8Array
  authenticatorAttachment?: PasskeyAttachment
  /** Undefined when the authenticator data did not parse. */
  backupEligible?: boolean
  /** ASN.1 DER ECDSA signature as returned by WebAuthn. */
  signatureDer: Uint8Array
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  /** The user handle the credential was created with (`userHandle.ts`); undefined when the
   *  authenticator returned none. */
  userHandle?: Uint8Array
}

export interface PasskeyCeremony {
  create(request: PasskeyCreateRequest): Promise<PasskeyCreateResult>
  assert(request: PasskeyAssertRequest): Promise<PasskeyAssertResult>
}

/**
 * Coarse facts about an answered credential, read before it is decoded, so a credential that then
 * fails to decode is still described. Never an id, a key, a signature or PRF output.
 */
export type PasskeyAnswerEvidence = {
  authenticatorAttachment?: PasskeyAttachment
  backupEligible?: boolean
  /** Creation only: the AAGUID as attested, all zeros included; absent without attested data. */
  aaguid?: string
  /** Creation only. */
  transports?: readonly string[]
}

/**
 * One native WebAuthn request of a `create` or `assert` call, carrying the request object that call
 * was given. `issued` precedes every native request, a re-issue after "already pending" included;
 * `answered` follows the one that returned a credential.
 */
export type PasskeyRequestSignal =
  | { phase: "issued"; kind: "create"; request: PasskeyCreateRequest }
  | { phase: "issued"; kind: "assert"; request: PasskeyAssertRequest }
  | {
      phase: "answered"
      kind: "create"
      request: PasskeyCreateRequest
      evidence: PasskeyAnswerEvidence
    }
  | {
      phase: "answered"
      kind: "assert"
      request: PasskeyAssertRequest
      evidence: PasskeyAnswerEvidence
    }

/** Watches native requests. Whatever it throws or returns is ignored. */
export type PasskeyRequestHook = (signal: PasskeyRequestSignal) => void

/**
 * A browser tab holds exactly one WebAuthn request. Chromium (Chrome, Brave, Edge) rejects a second
 * `create()`/`get()` with "A request is already pending." while an earlier one is still held, and a
 * held request can outlive the promise that started it — the Linux Google-Password-Manager PIN
 * dialog and the macOS system passkey sheet both do it — which poisons every later ceremony until
 * the page reloads.
 *
 * `withTabSlot` is the tab's one-request discipline, in three parts:
 *
 *   - **Serialize.** Ceremonies queue instead of overlapping, so the app never asks the browser for
 *     a second request. Cutting in front of a live ceremony would throw away a sheet the user is
 *     part-way through.
 *   - **Evict.** A holder that outstays `handoffWaitMs` is wedged rather than slow: abort it, give
 *     its teardown a grace window, and take the tab.
 *   - **Retry.** Teardown is asynchronous and can outlast the grace window, so a "still pending"
 *     rejection is re-issued on a backoff before it reaches the caller.
 *
 * The slot lives on `globalThis` because the limit belongs to the tab, not to this module — a second
 * bundled copy of this file has to queue behind the same holder.
 */
type TabSlot = {
  /** Resolves when the ceremony holding the tab releases it. */
  turn: Promise<void>
  /** The holder, so a waiter can evict it. */
  active?: { controller: AbortController }
  /** Told when the tab's request goes out and when it ends. */
  listeners?: Set<(active: boolean) => void>
}

const TAB_SLOT_KEY = "__zkMoneyWebAuthnTabSlot"
const globalScope = globalThis as typeof globalThis & { [TAB_SLOT_KEY]?: TabSlot }

function tabSlot(): TabSlot {
  return (globalScope[TAB_SLOT_KEY] ??= { turn: Promise.resolve() })
}

/**
 * Subscribe to the tab's WebAuthn request: `true` just before it goes to the browser, `false` once
 * it settles. Called synchronously, so a listener can change the page before the request is seen.
 */
export function onPasskeyRequest(listener: (active: boolean) => void): () => void {
  const listeners = (tabSlot().listeners ??= new Set())
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * An extension (1Password, Bitwarden, …) answers WebAuthn inside the page when it has swapped
 * `navigator.credentials.get` for its own script. Browser and OS prompts leave it native.
 */
export function extensionAnswersPasskeys(): boolean {
  try {
    return !Function.prototype.toString.call(navigator.credentials.get).includes("[native code]")
  } catch {
    return false
  }
}

function announce(slot: TabSlot, active: boolean): void {
  for (const listener of slot.listeners ?? []) {
    try {
      listener(active)
    } catch {
      // A listener never fails a ceremony.
    }
  }
}

const PENDING_REQUEST_RE = /request is already pending/i

/** Shown when the browser will not let go of an earlier request; only a reload clears that. */
const WEDGED_TAB_MESSAGE =
  "Your browser is still holding an earlier passkey request. Close any open passkey dialog, " +
  "reload this page, and try again."

const EVICTED_MESSAGE = "evicted a wedged passkey request"
const NO_CREATED_CREDENTIAL_MESSAGE = "Passkey creation returned no credential"
const NO_ASSERTED_CREDENTIAL_MESSAGE = "Passkey assertion returned no credential"
const BITWARDEN_RP_REFUSAL_MESSAGE = "'rp.id' cannot be used with the current origin"
const BITWARDEN_NOT_ALLOWED_MESSAGE = "The operation either timed out or was not allowed."
const NOT_ES256_PREFIX = "Passkey was created with algorithm "
const NOT_ES256_SUFFIX = ", not ES256; the account contract requires P-256"

/** A thrown value's `name` and `message`, each only when it is a string. */
function describeError(error: unknown): { name?: string; message?: string } {
  try {
    const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown }
    return {
      name: typeof name === "string" ? name : undefined,
      message: typeof message === "string" ? message : undefined,
    }
  } catch {
    return {}
  }
}

/** The tab's earlier request never let go, through every re-issue. */
export const isWedgedTabError = (error: unknown): boolean =>
  describeError(error).message === WEDGED_TAB_MESSAGE

/** A request aborted by a later ceremony that found it wedged. */
export function isEvictedRequestError(error: unknown): boolean {
  const { name, message } = describeError(error)
  return name === "AbortError" && message === EVICTED_MESSAGE
}

/** The browser resolved a request with no credential. */
export function isNoCredentialError(error: unknown): boolean {
  const { message } = describeError(error)
  return message === NO_CREATED_CREDENTIAL_MESSAGE || message === NO_ASSERTED_CREDENTIAL_MESSAGE
}

/** A creation answered with a key other than P-256. */
export function isUnsupportedAlgorithmError(error: unknown): boolean {
  const { message } = describeError(error)
  return Boolean(message?.startsWith(NOT_ES256_PREFIX) && message.endsWith(NOT_ES256_SUFFIX))
}

function isRpRefusal(error: unknown): boolean {
  const { name, message } = describeError(error)
  return name === "SecurityError" || message === BITWARDEN_RP_REFUSAL_MESSAGE
}

export type CeremonyTiming = {
  /** How long the tab's holder may run before a waiter treats it as wedged and aborts it. */
  handoffWaitMs: number
  /** Grace for an aborted request's asynchronous teardown before the waiter proceeds regardless. */
  teardownWaitMs: number
  /** How long to wait for a hidden or unfocused document before issuing anyway. */
  focusWaitMs: number
  /** Backoff for re-issuing while the browser still reports a pending request. */
  pendingRetryDelaysMs: readonly number[]
  /**
   * How long a creation may wait for an authenticator to answer. Without it the browser waits
   * without end when nothing it may offer exists — a phone asked for its own passkey where only a
   * roaming key is present never sees a sheet, and never sees a refusal either.
   */
  createTimeoutMs: number
}

export const DEFAULT_CEREMONY_TIMING: CeremonyTiming = {
  // A real ceremony is a human at a Touch ID sensor or a security key — minutes are plausible, so
  // eviction is deliberately slow. It only ever fires on a request that is already broken.
  handoffWaitMs: 90_000,
  teardownWaitMs: 1_500,
  focusWaitMs: 10_000,
  // Long enough for Chromium to release a phone (hybrid) session before the next request: a
  // sign-in's second assertion can follow the first by seconds.
  pendingRetryDelaysMs: [200, 500, 1_000, 2_000, 3_000, 3_000],
  // The steps that precede a creation send the user for their phone or key first, so the sheet
  // opens with the device already to hand. Past this the browser gives up and the screen offers
  // another attempt, which beats a prompt that waits for something that cannot arrive.
  createTimeoutMs: 60_000,
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Rejects with `signal`'s reason the moment it aborts; `detach` drops the listener once the race is over. */
function untilAborted(signal: AbortSignal): { aborted: Promise<never>; detach: () => void } {
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  return { aborted, detach: () => signal.removeEventListener("abort", onAbort) }
}

/**
 * Awaits `settled`; past `ms` runs `onDeadline` and hands back after `graceMs` rather than hanging.
 * An abort ends the wait at once, and a waiter that leaves this way never reaches its deadline.
 */
async function awaitWithDeadline(
  settled: Promise<void>,
  ms: number,
  onDeadline: () => void,
  graceMs: number,
  signal: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const reached = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms)
  })
  const { aborted, detach } = untilAborted(signal)
  try {
    const winner = await Promise.race([settled.then(() => "settled" as const), reached, aborted])
    if (winner === "settled") return
    onDeadline()
    await Promise.race([settled, sleep(graceMs), aborted])
  } finally {
    clearTimeout(timer)
    detach()
  }
}

/**
 * A request issued against a hidden or unfocused document is one Chromium holds until the tab comes
 * back, occupying the tab slot the whole time — so a ceremony started behind the user's back (a
 * background publish, a poll) waits for the page instead of parking a request nobody can answer.
 */
async function awaitDocumentReady(waitMs: number, signal: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined") return
  const ready = () => document.visibilityState !== "hidden" && document.hasFocus()
  if (ready()) return
  await new Promise<void>((resolve, reject) => {
    function stop() {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", done)
      window.removeEventListener("focus", done)
      signal.removeEventListener("abort", abort)
    }
    function done() {
      if (!ready()) return
      stop()
      resolve()
    }
    function abort() {
      stop()
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      stop()
      resolve()
    }, waitMs)
    document.addEventListener("visibilitychange", done)
    window.addEventListener("focus", done)
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function issueWithRetries<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  delaysMs: readonly number[],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(signal)
    } catch (err) {
      // DOMException is not `instanceof Error` in every realm — match on the message.
      if (!PENDING_REQUEST_RE.test(String((err as { message?: unknown })?.message ?? err)))
        throw err
      if (attempt >= delaysMs.length) throw new Error(WEDGED_TAB_MESSAGE, { cause: err })
      await sleep(delaysMs[attempt]!)
      signal.throwIfAborted()
    }
  }
}

async function withTabSlot<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timing: CeremonyTiming,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const slot = tabSlot()
  const turn = slot.turn
  let release!: () => void
  slot.turn = new Promise<void>((resolve) => (release = resolve))

  // The caller's signal ends this ceremony wherever it is: queued, waiting for focus, issued, or
  // between retries.
  const controller = new AbortController()
  const forward = () => controller.abort(signal!.reason)
  signal?.addEventListener("abort", forward, { once: true })
  let held = false
  try {
    await awaitWithDeadline(
      turn,
      timing.handoffWaitMs,
      () => slot.active?.controller.abort(new DOMException(EVICTED_MESSAGE, "AbortError")),
      timing.teardownWaitMs,
      controller.signal,
    )
    await awaitDocumentReady(timing.focusWaitMs, controller.signal)
    slot.active = { controller }
    held = true
    announce(slot, true)
    return await issueWithRetries(request, controller.signal, timing.pendingRetryDelaysMs)
  } finally {
    signal?.removeEventListener("abort", forward)
    if (held) {
      // An evicted holder's successor is already out; only the current holder may end the request.
      if (slot.active?.controller === controller) {
        slot.active = undefined
        announce(slot, false)
      }
      release()
    } else {
      // A waiter that left before its turn hands its place on only when that turn comes, so the
      // ceremonies behind it still queue behind the holder.
      void turn.then(release)
    }
  }
}

/**
 * One PRF slot from `clientExtensionResults.prf.results`. Anything but exactly 32 bytes is
 * treated as "this slot returned nothing": the derivation would throw on another length, which
 * would look like a crash instead of a missing result and skip the chained-assertion fallback.
 */
export function decodePrfSlot(results: unknown, slot: "first" | "second"): Uint8Array | undefined {
  const value = (results as Record<string, ArrayBuffer | Uint8Array | undefined> | undefined)?.[
    slot
  ]
  if (!value) return undefined
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  return bytes.length === 32 ? bytes : undefined
}

function toAttachment(value: string | null | undefined): PasskeyAttachment | undefined {
  return value === "platform" || value === "cross-platform" ? value : undefined
}

function readBackupEligible(authenticatorData: Uint8Array | undefined): boolean | undefined {
  if (!authenticatorData) return undefined
  try {
    return parseAuthenticatorDataFlags(authenticatorData).backupEligible
  } catch {
    return undefined
  }
}

/** Older browsers declare no `getTransports`, and it may throw; both mean the browser said nothing. */
function readTransports(response: AuthenticatorAttestationResponse): readonly string[] | undefined {
  if (typeof response.getTransports !== "function") return undefined
  try {
    return response.getTransports()
  } catch {
    return undefined
  }
}

export function readAaguid(authenticatorData: Uint8Array | undefined): string | undefined {
  if (!authenticatorData) return undefined
  try {
    return parseAaguid(authenticatorData)
  } catch {
    return undefined
  }
}

function prfInputs(first?: Uint8Array, second?: Uint8Array) {
  if (!first && !second) return undefined
  return {
    prf: {
      eval: {
        ...(first ? { first: first as BufferSource } : {}),
        ...(second ? { second: second as BufferSource } : {}),
      },
    },
  } as AuthenticationExtensionsClientInputs
}

// The DOM lib does not yet declare WebAuthn Level 3 `hints` on the raw option types.
type CreationOptionsL3 = PublicKeyCredentialCreationOptions & { hints?: readonly PasskeyHint[] }
type RequestOptionsL3 = PublicKeyCredentialRequestOptions & { hints?: readonly PasskeyHint[] }

/** `getPublicKey()` as bytes; undefined where the browser lacks it, or answers nothing, or throws. */
function readSpki(response: AuthenticatorAttestationResponse): Uint8Array | undefined {
  if (typeof response.getPublicKey !== "function") return undefined
  try {
    const spki = response.getPublicKey()
    return spki ? new Uint8Array(spki) : undefined
  } catch {
    return undefined
  }
}

/** What the browser reports as the key's algorithm, for a refusal; never a decision input. */
function readAlgorithm(response: AuthenticatorAttestationResponse): unknown {
  if (typeof response.getPublicKeyAlgorithm !== "function") return "unreported"
  try {
    return response.getPublicKeyAlgorithm()
  } catch {
    return "unreported"
  }
}

/** One read of a credential the browser handed back; a read that throws yields nothing. */
function tryRead<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function creationEvidence(credential: PublicKeyCredential): PasskeyAnswerEvidence {
  const response = tryRead(() => credential.response as AuthenticatorAttestationResponse)
  const authData =
    tryRead(() => new Uint8Array(response!.getAuthenticatorData())) ??
    tryRead(() => authDataFromAttestation(new Uint8Array(response!.attestationObject)))
  const transports = tryRead(() => readTransports(response!))
  return {
    authenticatorAttachment: tryRead(() => toAttachment(credential.authenticatorAttachment)),
    backupEligible: tryRead(() => parseAuthenticatorDataFlags(authData!).backupEligible),
    aaguid: tryRead(() => parseAttestedAaguid(authData!)),
    transports: Array.isArray(transports)
      ? transports.filter((t): t is string => typeof t === "string")
      : undefined,
  }
}

function assertionEvidence(credential: PublicKeyCredential): PasskeyAnswerEvidence {
  const response = tryRead(() => credential.response as AuthenticatorAssertionResponse)
  return {
    authenticatorAttachment: tryRead(() => toAttachment(credential.authenticatorAttachment)),
    backupEligible: tryRead(
      () => parseAuthenticatorDataFlags(new Uint8Array(response!.authenticatorData)).backupEligible,
    ),
  }
}

/** Hands a signal to the hook. Nothing the hook or the evidence read does reaches the ceremony. */
function notify(hook: PasskeyRequestHook | undefined, signal: () => PasskeyRequestSignal): void {
  if (!hook) return
  try {
    void Promise.resolve(hook(signal())).catch(() => {})
  } catch {
    // Telemetry never fails a ceremony.
  }
}

/** How long the browser held each rejected request, keyed by the error the ceremony threw for it. */
const heldFor = new WeakMap<object, number>()

/**
 * How long the browser held the request `error` came from, issue to rejection; undefined for an
 * error no request threw. Waits before the issue, for the tab or for focus, are not counted.
 */
export function requestHeldMs(error: unknown): number | undefined {
  return typeof error === "object" && error !== null ? heldFor.get(error) : undefined
}

async function withRpError<T>(rpId: string, request: () => Promise<T>): Promise<T> {
  const issuedAt = Date.now()
  try {
    return await request()
  } catch (error) {
    const thrown = rpErrorFor(rpId, error)
    if (typeof thrown === "object" && thrown !== null) heldFor.set(thrown, Date.now() - issuedAt)
    throw thrown
  }
}

function rpErrorFor(rpId: string, error: unknown): unknown {
  if (
    isRpRefusal(error) &&
    typeof location !== "undefined" &&
    !isRpDomainSuffix(location.hostname, rpId)
  ) {
    return new RelatedOriginPasskeyError(error, {
      iosBelowFloor: iosBelowFloor(parseUserAgent({ userAgent: navigator.userAgent })),
    })
  }
  const { name, message } = describeError(error)
  if (name === "Error" && message === BITWARDEN_NOT_ALLOWED_MESSAGE) {
    return new DOMException(message, "NotAllowedError")
  }
  return error
}

export class BrowserPasskeyCeremony implements PasskeyCeremony {
  constructor(
    private readonly timing: CeremonyTiming = DEFAULT_CEREMONY_TIMING,
    private readonly onRequest?: PasskeyRequestHook,
  ) {}

  async create(request: PasskeyCreateRequest): Promise<PasskeyCreateResult> {
    const publicKey: CreationOptionsL3 = {
      rp: { id: request.rpId, name: request.rpName },
      // The name rides in the handle so an assertion anywhere hands it back; no secret (the PRF
      // only exists after create).
      user: {
        id: encodeUserHandle(request.userName),
        name: request.userName,
        displayName: request.userName,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // ES256 alone. The account contract verifies nothing else, so offering a second algorithm
      // only invites an authenticator to mint a credential this wallet must then refuse — and a
      // refusal after `create` strands that credential on the authenticator. Offering one lets
      // the browser refuse before it writes anything.
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required", // load-bearing: hmac-secret/PRF keys on UV
        ...(request.authenticatorAttachment
          ? { authenticatorAttachment: request.authenticatorAttachment }
          : {}),
      },
      ...(request.hints ? { hints: request.hints } : {}),
      attestation: "none",
      timeout: this.timing.createTimeoutMs,
      extensions: prfInputs(request.prfFirstSalt, request.prfSecondSalt),
    }
    const credential = (await withTabSlot((signal) => {
      notify(this.onRequest, () => ({ phase: "issued", kind: "create", request }))
      return withRpError(request.rpId, () => navigator.credentials.create({ signal, publicKey }))
    }, this.timing)) as PublicKeyCredential | null
    if (!credential) throw new Error(NO_CREATED_CREDENTIAL_MESSAGE)
    // The authenticator has saved the passkey: anything thrown from here leaves it behind.
    try {
      notify(this.onRequest, () => ({
        phase: "answered",
        kind: "create",
        request,
        evidence: creationEvidence(credential),
      }))

      const response = credential.response as AuthenticatorAttestationResponse
      // The attestation object is the one source the spec guarantees; the accessor methods are
      // the browser's own parse of it, and a browser that cannot parse a given shape answers them
      // with defaults instead of errors. Each accessor is tried first and the raw bytes stand in.
      const attestation = new Uint8Array(response.attestationObject)
      const authData =
        typeof response.getAuthenticatorData === "function"
          ? new Uint8Array(response.getAuthenticatorData())
          : authDataFromAttestation(attestation)
      const spki = readSpki(response)
      const pubkey =
        (spki && p256FromSpki(spki)) ?? (authData && p256FromAuthData(authData)) ?? undefined
      if (!pubkey) {
        // Only ES256 was offered, so a key that is not P-256 means the authenticator ignored the
        // request. The refusal names what the browser reported and who answered, so a report of
        // it says which of those it was.
        const alg = readAlgorithm(response)
        const provider = readAaguid(authData) ?? "unknown provider"
        throw new Error(`${NOT_ES256_PREFIX}${String(alg)} by ${provider}${NOT_ES256_SUFFIX}`)
      }

      const extensions = credential.getClientExtensionResults() as { prf?: { results?: unknown } }
      return {
        credentialId: credential.id,
        pubkey,
        prfFirst: decodePrfSlot(extensions.prf?.results, "first"),
        prfSecond: decodePrfSlot(extensions.prf?.results, "second"),
        authenticatorAttachment: toAttachment(credential.authenticatorAttachment),
        backupEligible: readBackupEligible(authData),
        aaguid: readAaguid(authData),
        transports: readTransports(response),
      }
    } catch (err) {
      throw markPasskeyWritten(err)
    }
  }

  async assert(request: PasskeyAssertRequest): Promise<PasskeyAssertResult> {
    const publicKey: RequestOptionsL3 = {
      rpId: request.rpId,
      challenge: request.challenge as BufferSource,
      userVerification: "required",
      allowCredentials: request.credentialIds?.map((id) => ({
        id: base64UrlToBytes(id) as BufferSource,
        type: "public-key" as const,
        ...(request.transports?.length
          ? { transports: request.transports as AuthenticatorTransport[] }
          : {}),
      })),
      ...(request.hints ? { hints: request.hints } : {}),
      extensions: prfInputs(request.prfFirstSalt, request.prfSecondSalt),
    }
    const credential = (await withTabSlot(
      (signal) => {
        notify(this.onRequest, () => ({ phase: "issued", kind: "assert", request }))
        return withRpError(request.rpId, () => navigator.credentials.get({ signal, publicKey }))
      },
      this.timing,
      request.signal,
    )) as PublicKeyCredential | null
    if (!credential) throw new Error(NO_ASSERTED_CREDENTIAL_MESSAGE)
    notify(this.onRequest, () => ({
      phase: "answered",
      kind: "assert",
      request,
      evidence: assertionEvidence(credential),
    }))

    const response = credential.response as AuthenticatorAssertionResponse
    const extensions = credential.getClientExtensionResults() as {
      prf?: { results?: unknown }
    }
    const authenticatorData = new Uint8Array(response.authenticatorData)
    return {
      credentialId: credential.id,
      prfFirst: decodePrfSlot(extensions.prf?.results, "first"),
      prfSecond: decodePrfSlot(extensions.prf?.results, "second"),
      authenticatorAttachment: toAttachment(credential.authenticatorAttachment),
      backupEligible: readBackupEligible(authenticatorData),
      signatureDer: new Uint8Array(response.signature),
      authenticatorData,
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      ...(response.userHandle ? { userHandle: new Uint8Array(response.userHandle) } : {}),
    }
  }
}
