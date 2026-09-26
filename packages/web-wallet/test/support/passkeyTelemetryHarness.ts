/**
 * The wallet's real passkey tracker over requests the test answers, for screen suites that mock the
 * operations above the ceremony. A mock asks through `request`, so its attempt counts a native
 * request the way the real ceremony would have; without one, a success is not reported at all.
 */
import type {
  PasskeyAnswerEvidence,
  PasskeyAssertRequest,
  PasskeyAssertResult,
  PasskeyCeremony,
  PasskeyCeremonyProps,
  PasskeyCreateRequest,
  PasskeyCreateResult,
  PasskeyRequestHook,
  PasskeyRequestScope,
  PasskeyRequestSignal,
} from "@obsidion/passkey-web"

type Kind = PasskeyRequestSignal["kind"]

/** One native request waiting on the test. */
export type HeldRequest = {
  kind: Kind
  /** The browser answers: the tracker hears `answered`, then the call resolves. */
  answer: (evidence?: PasskeyAnswerEvidence) => void
  /** The browser rejects without an answer. */
  reject: (error: unknown) => void
  /** The wrapped call, as the code that asked awaits it. */
  settled: Promise<unknown>
}

/** A passkey on this device, as its answer describes it. */
export const LOCAL_ANSWER: PasskeyAnswerEvidence = {
  authenticatorAttachment: "platform",
  backupEligible: true,
}

const CREATED: PasskeyCreateResult = {
  credentialId: "held",
  pubkey: new Uint8Array(64),
  transports: undefined,
}
const ASSERTED: PasskeyAssertResult = {
  credentialId: "held",
  signatureDer: new Uint8Array(0),
  authenticatorData: new Uint8Array(37),
  clientDataJSON: new Uint8Array(0),
}

/**
 * Requests that wait for the test, reported the way the browser ceremony reports them. A request
 * carrying a signal rejects with `AbortError` when it aborts, as the browser's does.
 */
class HeldCeremony implements PasskeyCeremony {
  readonly requests: Omit<HeldRequest, "settled">[] = []

  constructor(private readonly hear: PasskeyRequestHook) {}

  create(request: PasskeyCreateRequest): Promise<PasskeyCreateResult> {
    return this.hold("create", request, CREATED)
  }

  assert(request: PasskeyAssertRequest): Promise<PasskeyAssertResult> {
    return this.hold("assert", request, ASSERTED)
  }

  private hold<T>(
    kind: Kind,
    request: PasskeyCreateRequest | PasskeyAssertRequest,
    result: T,
  ): Promise<T> {
    this.hear({ phase: "issued", kind, request } as PasskeyRequestSignal)
    return new Promise<T>((resolve, reject) => {
      this.requests.push({
        kind,
        answer: (evidence = LOCAL_ANSWER) => {
          this.hear({ phase: "answered", kind, request, evidence } as PasskeyRequestSignal)
          resolve(result)
        },
        reject,
      })
      const { signal } = request as PasskeyAssertRequest
      signal?.addEventListener("abort", () =>
        reject(new DOMException("The request was aborted.", "AbortError")),
      )
    })
  }
}

/** Build it from the same module registry as the screen, so both share one tracker. */
export async function passkeyTelemetryHarness() {
  const { passkeyTelemetry } = await import("../../src/lib/passkeyTelemetry")
  const held = new HeldCeremony((signal) => passkeyTelemetry.requestHook(signal))
  const ceremony = passkeyTelemetry.wrap(held)

  /**
   * Issues one request through the tracker, left for the test to answer or reject. `own` is the
   * scope the operation was handed, so the request belongs to that attempt.
   */
  const request = (
    kind: Kind = "assert",
    signal?: AbortSignal,
    own?: PasskeyRequestScope,
  ): HeldRequest => {
    const asking = own ? own(ceremony) : ceremony
    const settled: Promise<unknown> =
      kind === "create"
        ? asking.create({
            rpId: "localhost",
            rpName: "zk.money",
            userName: "@test",
            prfFirstSalt: new Uint8Array(32),
          })
        : asking.assert({
            rpId: "localhost",
            challenge: new Uint8Array(32),
            ...(signal ? { signal } : {}),
          })
    // A rejection the test causes and nobody awaits is not an unhandled one.
    settled.catch(() => {})
    return { ...held.requests.at(-1)!, settled }
  }

  return {
    request,
    /** One request, answered at once. */
    answered: (kind: Kind = "assert", own?: PasskeyRequestScope) => {
      const held = request(kind, undefined, own)
      held.answer()
      return held.settled
    },
  }
}

/** The props of every `passkey_ceremony` a mocked `fireEvent` was given, in order. */
export const passkeyEvents = (fireEvent: { mock: { calls: unknown[][] } }) =>
  fireEvent.mock.calls
    .filter(([name]) => name === "passkey_ceremony")
    .map(([, props]) => props as PasskeyCeremonyProps)

export const pageHide = () => window.dispatchEvent(new Event("pagehide"))
