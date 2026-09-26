// @vitest-environment jsdom
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID } from "@obsidion/core/constants"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bytesToHex, hexToBytes } from "../src/ceremony/bytes.js"
import {
  BrowserPasskeyCeremony,
  type CeremonyTiming,
  type PasskeyAnswerEvidence,
  type PasskeyAssertRequest,
  type PasskeyAssertResult,
  type PasskeyCeremony,
  type PasskeyCreateRequest,
  type PasskeyRequestHook,
  type PasskeyRequestSignal,
} from "../src/ceremony/passkeyCeremony.js"
import { runPasskeyAssertion, runPasskeyCreation } from "../src/policy/drivers.js"
import { UnsupportedProviderError } from "../src/policy/passkeyErrors.js"
import {
  type PasskeyAttemptContext,
  type PasskeyCeremonyProps,
  type PasskeyTelemetryEnvironment,
  type PasskeyTelemetryOptions,
  createPasskeyTelemetry,
} from "../src/policy/passkeyTelemetryTracker.js"
import {
  PASSKEY_CEREMONY_ENUM_PROPS,
  PASSKEY_CEREMONY_INTEGER_PROPS,
  PASSKEY_MAJOR_MAX,
  PASSKEY_MAJOR_MIN,
} from "../src/policy/passkeyTelemetryVocabulary.js"
import { parseUserAgent } from "../src/policy/userAgentInfo.js"
import { FakePasskeyCeremony } from "./support/fakePasskeyCeremony.js"

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"

/** What Client Hints add once the async read resolves. */
const HINTED_MAC: PasskeyTelemetryEnvironment = {
  posture: "laptop",
  userAgent: parseUserAgent({
    userAgent: CHROME_MAC,
    userAgentData: { platform: "macOS", platformVersion: "15.1.0" },
  }),
}
const HINTED_MAC_PROPS = {
  device_class: "laptop",
  os: "macos",
  os_major: 15,
  browser: "chrome",
  browser_major: 140,
}

/** Every object any tracker in this file sent through the default harness. */
const everySent: PasskeyCeremonyProps[] = []

function harness(options: Partial<PasskeyTelemetryOptions> = {}) {
  let time = 0
  const sent: PasskeyCeremonyProps[] = []
  const pageHideTarget = new EventTarget()
  const telemetry = createPasskeyTelemetry({
    send: (props) => {
      sent.push(props)
      everySent.push(props)
    },
    now: () => time,
    environment: () => Promise.resolve(HINTED_MAC),
    syncEnvironment: () => ({
      posture: "laptop",
      userAgent: parseUserAgent({ userAgent: CHROME_MAC }),
    }),
    pageHideTarget,
    ...options,
  })
  return {
    telemetry,
    sent,
    pageHideTarget,
    advance: (ms: number) => void (time += ms),
    pageHide: () => pageHideTarget.dispatchEvent(new Event("pagehide")),
  }
}

type Step = {
  /** Holds the call after it issues, until this settles. */
  hold?: Promise<unknown>
  /** How long the request takes on the tracker's clock. */
  takes?: number
  answer?: PasskeyAnswerEvidence
  /** Thrown after the answer, or with no answer. */
  error?: unknown
  credentialId?: string
}

/** Each call signals `issued`, then plays the next step. */
function scripted(hook: PasskeyRequestHook, advance: (ms: number) => void, steps: Step[]) {
  async function play(kind: "create" | "assert", request: object): Promise<never> {
    const step = steps.shift() ?? {}
    hook({ phase: "issued", kind, request } as PasskeyRequestSignal)
    await step.hold
    advance(step.takes ?? 0)
    if (step.answer) {
      hook({ phase: "answered", kind, request, evidence: step.answer } as PasskeyRequestSignal)
    }
    if (step.error !== undefined) throw step.error
    return { credentialId: step.credentialId ?? "cred-1", pubkey: new Uint8Array(64) } as never
  }
  return {
    create: (request) => play("create", request),
    assert: (request) => play("assert", request),
  } satisfies PasskeyCeremony
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const createRequest = (): PasskeyCreateRequest => ({
  rpId: "localhost",
  rpName: "zk.money",
  userName: "@alice",
  prfFirstSalt: new Uint8Array(32),
})
const assertRequest = (over: Partial<PasskeyAssertRequest> = {}): PasskeyAssertRequest => ({
  rpId: "localhost",
  challenge: new Uint8Array(32),
  ...over,
})

/** A phone over QR answering a creation, and this device answering an assertion. */
const QR_CREATE: PasskeyAnswerEvidence = {
  authenticatorAttachment: "cross-platform",
  backupEligible: true,
  aaguid: APPLE_ICLOUD_AAGUID,
  transports: ["hybrid", "internal"],
}
const LOCAL_ASSERT: PasskeyAnswerEvidence = {
  authenticatorAttachment: "platform",
  backupEligible: false,
}

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

afterEach(() => {
  for (const props of everySent.splice(0)) {
    for (const [key, value] of Object.entries(props)) {
      if ((PASSKEY_CEREMONY_INTEGER_PROPS as readonly string[]).includes(key)) {
        expect(Number.isInteger(value), key).toBe(true)
        expect(value as number).toBeGreaterThanOrEqual(PASSKEY_MAJOR_MIN)
        expect(value as number).toBeLessThanOrEqual(PASSKEY_MAJOR_MAX)
        continue
      }
      expect(Object.keys(PASSKEY_CEREMONY_ENUM_PROPS), key).toContain(key)
      const listed = PASSKEY_CEREMONY_ENUM_PROPS[key as keyof typeof PASSKEY_CEREMONY_ENUM_PROPS]
      expect(listed as readonly unknown[], key).toContain(value)
    }
  }
})

describe("wrap", () => {
  it("hands the inner ceremony a fresh copy per call and passes its answer back untouched", async () => {
    const { telemetry } = harness()
    const seen: object[] = []
    const answer = { credentialId: "cred-1" } as PasskeyAssertResult
    const failure = new DOMException("Dismissed", "NotAllowedError")
    const inner: PasskeyCeremony = {
      create: () => Promise.reject(failure),
      assert: (request) => {
        seen.push(request)
        return Promise.resolve(answer)
      },
    }
    const wrapped = telemetry.wrap(inner)
    const signal = new AbortController().signal
    const request = assertRequest({ credentialIds: ["cred-1"], signal })

    expect(await wrapped.assert(request)).toBe(answer)
    expect(await wrapped.assert(request)).toBe(answer)
    expect(seen[0]).not.toBe(request)
    expect(seen[1]).not.toBe(seen[0])
    expect(seen[0]).toEqual(request)
    expect((seen[0] as PasskeyAssertRequest).signal).toBe(signal)
    expect(await caught(wrapped.create(createRequest()))).toBe(failure)
  })

  it("counts a call that never reached the browser as no prompt", async () => {
    const h = harness()
    const quiet = h.telemetry.wrap(new FakePasskeyCeremony({ aaguid: APPLE_ICLOUD_AAGUID }))
    const refusal = new UnsupportedProviderError("manager")
    const error = await caught(
      h.telemetry.track({ ceremony: "create" }, async () => {
        await quiet.create(createRequest())
        throw refusal
      }),
    )
    expect(error).toBe(refusal)
    expect(h.sent).toEqual([
      {
        ceremony: "create",
        outcome: "refused",
        reason: "provider_not_supported",
        provider: "unknown",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "0",
        ...HINTED_MAC_PROPS,
      },
    ])
  })
})

describe("one event per attempt", () => {
  it("describes a created passkey", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
      route: "cross-device",
      transports: ["hybrid", "internal"],
    })
    const ceremony = h.telemetry.wrap(fake)
    await Promise.resolve()

    const created = await h.telemetry.track({ ceremony: "create", flow: "onboarding" }, () =>
      ceremony.create(createRequest()),
    )

    expect(h.sent).toEqual([
      {
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        provider: "icloud_keychain",
        credential_created: "yes",
        backup_eligible: "yes",
        route: "phone_qr",
        prompts: "1",
        attempt: "1",
        elapsed: "under_1s",
        ...HINTED_MAC_PROPS,
      },
    ])
    const serialized = JSON.stringify(h.sent)
    for (const secret of [
      APPLE_ICLOUD_AAGUID,
      APPLE_ICLOUD_AAGUID.replace(/-/g, ""),
      created.credentialId,
      bytesToHex(created.pubkey),
      bytesToHex(created.prfFirst!),
      CHROME_MAC,
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("keeps a created credential when the chained assertion is cancelled", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
      route: "cross-device",
      prfAtCreate: false,
      assertOverride: () => {
        throw new DOMException("Dismissed", "NotAllowedError")
      },
    })
    const ceremony = h.telemetry.wrap(fake)
    const creating = h.telemetry.track({ ceremony: "create" }, () =>
      runPasskeyCreation(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => new Uint8Array(32),
      }),
    )
    await expect(creating).rejects.toThrow(/Dismissed/)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({
      ceremony: "create",
      outcome: "cancelled",
      reason: "prompt_closed",
      provider: "icloud_keychain",
      credential_created: "yes",
      prompts: "2+",
    })
  })

  it("marks a creation the browser refused as not created", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { error: new DOMException("insecure", "SecurityError") },
      ]),
    )
    await caught(h.telemetry.track({ ceremony: "create" }, () => ceremony.create(createRequest())))
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "security_error",
        provider: "unknown",
        credential_created: "no",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("takes the route from the first answer and the duration from the last request", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { takes: 20_000, answer: QR_CREATE },
        { takes: 2_000, answer: LOCAL_ASSERT },
      ]),
    )
    await h.telemetry.track({ ceremony: "create" }, async () => {
      await ceremony.create(createRequest())
      h.advance(5_000)
      return ceremony.assert(assertRequest())
    })
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        route: "phone_qr",
        backup_eligible: "yes",
        prompts: "2+",
        elapsed: "1_10s",
      }),
    ])
  })

  it("classifies what a run throws, and throws it unchanged", async () => {
    const h = harness()
    const steps: Step[] = []
    const ceremony = h.telemetry.wrap(scripted(h.telemetry.requestHook, h.advance, steps))
    const refusal = new UnsupportedProviderError("manager")
    const outage = new Error("rpc down")
    const typeError = new TypeError("Cannot read properties of undefined")

    steps.push({ answer: QR_CREATE })
    const refused = h.telemetry.track({ ceremony: "create" }, async () => {
      await ceremony.create(createRequest())
      throw refusal
    })
    expect(await caught(refused)).toBe(refusal)

    steps.push({ answer: LOCAL_ASSERT })
    const failedAfter = h.telemetry.track({ ceremony: "sign_in" }, async () => {
      await ceremony.assert(assertRequest())
      throw outage
    })
    expect(await caught(failedAfter)).toBe(outage)

    steps.push({ error: typeError })
    const failedBefore = h.telemetry.track({ ceremony: "sign_in" }, () =>
      ceremony.assert(assertRequest()),
    )
    expect(await caught(failedBefore)).toBe(typeError)

    expect(h.sent.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ["refused", "provider_not_supported"],
      ["failed", "after_prompt"],
      ["failed", "request_failed"],
    ])
    expect(JSON.stringify(h.sent)).not.toMatch(/rpc down|Cannot read|YubiKey|passkey manager/)
  })

  it("classifies a resolved value and returns it unchanged", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    const value = { entered: false, reason: "unknown" as const }
    const result = await h.telemetry.track(
      { ceremony: "sign_in", flow: "enter" },
      async () => {
        await ceremony.assert(assertRequest())
        return value
      },
      (entered) =>
        entered.reason === "unknown"
          ? { outcome: "refused", reason: "no_wallet_for_passkey" }
          : undefined,
    )
    expect(result).toBe(value)
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "refused",
        reason: "no_wallet_for_passkey",
        route: "same_device",
        backup_eligible: "no",
        prompts: "1",
      }),
    ])
    expect(h.sent[0]).not.toHaveProperty("credential_created")
  })

  it("sends nothing for an attempt that asked nothing and ended unexplained", async () => {
    const h = harness()
    expect(await h.telemetry.track({ ceremony: "unlock" }, async () => 7)).toBe(7)
    const error = new TypeError("x")
    expect(
      await caught(h.telemetry.track({ ceremony: "unlock" }, () => Promise.reject(error))),
    ).toBe(error)
    expect(h.sent).toEqual([])
  })

  it("sends a prompt-free outcome once per page load, per ceremony and flow", () => {
    const h = harness()
    const refused = (context: PasskeyAttemptContext) =>
      h.telemetry.begin(context).end({ outcome: "refused", reason: "phone_unreachable" })
    refused({ ceremony: "create" })
    refused({ ceremony: "create" })
    refused({ ceremony: "sign_in" })
    refused({ ceremony: "unlock", flow: "unlock" })
    refused({ ceremony: "unlock", flow: "unlock" })
    refused({ ceremony: "unlock", flow: "deposit" })
    expect(h.sent).toEqual([
      {
        ceremony: "create",
        outcome: "refused",
        reason: "phone_unreachable",
        provider: "unknown",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "0",
        device_class: "laptop",
        os: "macos",
        browser: "chrome",
        browser_major: 140,
      },
      expect.objectContaining({ ceremony: "sign_in", reason: "phone_unreachable" }),
      // The same refusal on another flow is its own reading, not a repeat.
      expect.objectContaining({ ceremony: "unlock", flow: "unlock" }),
      expect.objectContaining({ ceremony: "unlock", flow: "deposit" }),
    ])
  })

  it("reports a request outside any attempt as untracked, once", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    await ceremony.assert(assertRequest())
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "untracked",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("gives a nested attempt's request to the inner attempt only", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    await h.telemetry.track({ ceremony: "sign_in", flow: "send" }, () =>
      h.telemetry.track({ ceremony: "approve_tx", flow: "send" }, () =>
        ceremony.assert(assertRequest()),
      ),
    )
    expect(h.sent).toEqual([expect.objectContaining({ ceremony: "approve_tx", prompts: "1" })])
  })

  it("numbers the attempts that asked, across kinds, in one page load", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { error: new DOMException("Dismissed", "NotAllowedError") },
        { answer: LOCAL_ASSERT },
        { answer: LOCAL_ASSERT },
        { answer: LOCAL_ASSERT },
      ]),
    )
    await caught(h.telemetry.track({ ceremony: "create" }, () => ceremony.create(createRequest())))
    h.telemetry
      .begin({ ceremony: "sign_in" })
      .end({ outcome: "refused", reason: "phone_unreachable" })
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
    await h.telemetry.track({ ceremony: "unlock" }, () => ceremony.assert(assertRequest()))
    await ceremony.assert(assertRequest())
    expect(h.sent.map((props) => [props.ceremony, props.attempt])).toEqual([
      ["create", "1"],
      ["sign_in", undefined],
      ["sign_in", "2"],
      ["unlock", "3+"],
      ["untracked", "3+"],
    ])
  })
})

describe("each run owns the requests it makes", () => {
  it("keeps a replaced creation's chained assertion out of the sign-in that began meanwhile", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      route: "cross-device",
      prfAtCreate: false,
      aaguid: GPM_AAGUID,
      transports: ["hybrid", "internal"],
    })
    const answer = deferred()
    const ceremony = h.telemetry.wrap({
      create: async (request) => {
        await answer.promise
        return fake.create(request)
      },
      assert: (request) => fake.assert(request),
    })

    const creating = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
    const created = creating.run((own) =>
      runPasskeyCreation(own(ceremony), {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => new Uint8Array(32),
      }),
    )
    // The user gives up on the creation and signs in instead; the phone answers the create anyway,
    // and the driver chains its assertion while the sign-in is the newest attempt.
    creating.superseded()
    const signingIn = h.telemetry.begin({ ceremony: "sign_in", flow: "enter" })
    const dismissed = deferred()
    const entering = caught(signingIn.run(() => dismissed.promise))

    answer.resolve()
    expect((await created).chained).toBeDefined()
    dismissed.reject(new DOMException("Dismissed", "NotAllowedError"))
    await entering

    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        credential_created: "yes",
        route: "phone_qr",
        prompts: "2+",
        attempt: "1",
      }),
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "cancelled",
        reason: "prompt_closed",
        prompts: "0",
      }),
    ])
    expect(h.sent[1]).not.toHaveProperty("attempt")
    expect(h.sent[1]).not.toHaveProperty("elapsed")
  })

  it("gives two attempts running at once their own requests", async () => {
    const h = harness()
    const gate = deferred()
    const holdA = deferred()
    const holdB = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: holdB.promise, answer: LOCAL_ASSERT },
        { hold: holdA.promise, answer: QR_CREATE, takes: 20_000 },
      ]),
    )
    // The creation waits at its phone steps while the sign-in asks, so it is the older attempt
    // that asks last.
    const a = h.telemetry.begin({ ceremony: "create" })
    const creating = a.run(async (own) => {
      await gate.promise
      return own(ceremony).create(createRequest())
    })
    const b = h.telemetry.begin({ ceremony: "sign_in" })
    const entering = b.run((own) => own(ceremony).assert(assertRequest()))
    gate.resolve()

    holdB.resolve()
    await entering
    holdA.resolve()
    await creating

    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        outcome: "succeeded",
        route: "same_device",
        prompts: "1",
        attempt: "1",
        elapsed: "under_1s",
      }),
      expect.objectContaining({
        ceremony: "create",
        outcome: "succeeded",
        credential_created: "yes",
        route: "phone_qr",
        prompts: "1",
        attempt: "2",
        elapsed: "10_60s",
      }),
    ])
  })
})

describe("end causes", () => {
  class GateCancelledError extends Error {
    override name = "GateCancelledError"
  }

  it("reports the user's cancel before any request as an in-app cancel", async () => {
    const h = harness()
    const gate = deferred()
    const attempt = h.telemetry.begin({ ceremony: "unlock", flow: "unlock" })
    const running = attempt.run(() => gate.promise)
    attempt.userCancelled()
    const cancel = new GateCancelledError()
    gate.reject(cancel)
    expect(await caught(running)).toBe(cancel)
    expect(h.sent).toEqual([
      {
        ceremony: "unlock",
        flow: "unlock",
        outcome: "cancelled",
        reason: "in_app_cancel",
        provider: "unknown",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "0",
        ...HINTED_MAC_PROPS,
      },
    ])
  })

  it("reports the user's cancel whatever the request then threw", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: hold.promise, error: new DOMException("aborted", "AbortError") },
      ]),
    )
    const attempt = h.telemetry.begin({ ceremony: "sign_in" })
    const running = attempt.run(() => ceremony.assert(assertRequest()))
    attempt.userCancelled()
    hold.resolve()
    await caught(running)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
  })

  it("keeps a cancelled attempt and its successor apart", async () => {
    for (const [aAsked, bAttempt] of [
      [false, "1"],
      [true, "2"],
    ] as const) {
      const h = harness()
      const holdA = deferred()
      const holdB = deferred()
      const answerB: Step = { hold: holdB.promise, answer: LOCAL_ASSERT }
      const steps: Step[] = aAsked
        ? [{ hold: holdA.promise, error: new GateCancelledError() }, answerB]
        : [answerB]
      const ceremony = h.telemetry.wrap(scripted(h.telemetry.requestHook, h.advance, steps))
      const a = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
      const runningA = a.run(async () => {
        if (aAsked) return ceremony.create(createRequest())
        await holdA.promise
        throw new GateCancelledError()
      })
      a.userCancelled()
      const b = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
      const runningB = b.run(() => ceremony.assert(assertRequest()))
      holdA.resolve()
      await caught(runningA)
      holdB.resolve()
      await runningB
      expect(h.sent.map(({ outcome, reason, attempt }) => [outcome, reason, attempt])).toEqual([
        ["cancelled", "in_app_cancel", aAsked ? "1" : undefined],
        ["succeeded", undefined, bAttempt],
      ])
    }
  })

  it("sends nothing when a replaced or unmounted attempt fails, and still reports its success", async () => {
    for (const mark of ["superseded", "unmounted"] as const) {
      const h = harness()
      const ceremony = h.telemetry.wrap(
        scripted(h.telemetry.requestHook, h.advance, [
          { error: new DOMException("aborted", "AbortError") },
          { answer: LOCAL_ASSERT },
        ]),
      )
      const failing = h.telemetry.begin({ ceremony: "sign_in" })
      const failed = failing.run(() => ceremony.assert(assertRequest()))
      failing[mark]()
      await caught(failed)
      expect(h.sent).toEqual([])

      const succeeding = h.telemetry.begin({ ceremony: "sign_in" })
      const succeeded = succeeding.run(() => ceremony.assert(assertRequest()))
      succeeding[mark]()
      await succeeded
      expect(h.sent).toEqual([expect.objectContaining({ outcome: "succeeded" })])
    }
  })

  it("lets the first explicit cause win", async () => {
    const cancelledFirst = harness()
    const gate = deferred()
    const a = cancelledFirst.telemetry.begin({ ceremony: "unlock" })
    const runningA = a.run(() => gate.promise)
    a.userCancelled()
    a.unmounted()
    a.superseded()
    gate.reject(new GateCancelledError())
    await caught(runningA)
    expect(cancelledFirst.sent).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel" }),
    ])

    const unmountedFirst = harness()
    const gateB = deferred()
    const b = unmountedFirst.telemetry.begin({ ceremony: "unlock" })
    const runningB = b.run(() => gateB.promise)
    b.unmounted()
    b.userCancelled()
    gateB.reject(new GateCancelledError())
    await caught(runningB)
    expect(unmountedFirst.sent).toEqual([])
  })

  it("closes an idle attempt that is replaced or unmounted, without a word", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    const attempt = h.telemetry.begin({ ceremony: "sign_in", flow: "enter" })
    attempt.superseded()
    attempt.userCancelled()
    attempt.end({ outcome: "refused", reason: "phone_unreachable" })
    // A run started after all that is the next attempt of the same kind, and reports as one.
    expect(
      await attempt.run(async () => (await ceremony.assert(assertRequest())).credentialId),
    ).toBe("cred-1")
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("reports the user's cancel when an idle cancelled attempt is then unmounted", () => {
    const h = harness()
    const attempt = h.telemetry.begin({ ceremony: "create" })
    attempt.userCancelled()
    attempt.unmounted()
    attempt.end({ outcome: "refused", reason: "phone_unreachable" })
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
      }),
    ])
  })

  it("ends a cancelled attempt as an in-app cancel whatever outcome it is given", () => {
    const h = harness()
    const attempt = h.telemetry.begin({ ceremony: "sign_in" })
    attempt.userCancelled()
    attempt.end({ outcome: "refused", reason: "phone_unreachable" })
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel" }),
    ])
  })
})

describe("pagehide", () => {
  it("abandons an attempt still waiting on its request, inside the handler, and forgets it", async () => {
    const h = harness()
    const add = vi.spyOn(h.pageHideTarget, "addEventListener")
    const remove = vi.spyOn(h.pageHideTarget, "removeEventListener")
    h.pageHide()
    expect(h.sent).toEqual([])
    expect(add).not.toHaveBeenCalled()

    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ hold: hold.promise, answer: LOCAL_ASSERT }]),
    )
    const running = h.telemetry.track({ ceremony: "sign_in", flow: "enter" }, () =>
      ceremony.assert(assertRequest()),
    )
    expect(add).toHaveBeenCalledTimes(1)
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "abandoned",
        prompts: "1",
      }),
    ])
    expect(h.sent[0]).not.toHaveProperty("reason")
    expect(remove).toHaveBeenCalledTimes(1)

    hold.resolve()
    await running
    h.pageHide()
    expect(h.sent).toHaveLength(1)
  })

  it("abandons an attempt that has not asked yet", () => {
    const h = harness()
    h.telemetry.begin({ ceremony: "create" })
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "abandoned", prompts: "0" }),
    ])
    expect(h.sent[0]).not.toHaveProperty("attempt")
    expect(h.sent[0]).not.toHaveProperty("elapsed")
  })

  it("reports a cancelled attempt as cancelled, and its late failure as nothing", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: hold.promise, error: new DOMException("aborted", "AbortError") },
      ]),
    )
    const attempt = h.telemetry.begin({ ceremony: "sign_in" })
    const running = attempt.run(() => ceremony.assert(assertRequest()))
    attempt.userCancelled()
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
    hold.resolve()
    await caught(running)
    expect(h.sent).toHaveLength(1)
  })

  it("sends nothing for a replaced or unmounted attempt, then or later", async () => {
    for (const mark of ["superseded", "unmounted"] as const) {
      const h = harness()
      const hold = deferred()
      const ceremony = h.telemetry.wrap(
        scripted(h.telemetry.requestHook, h.advance, [
          { hold: hold.promise, answer: LOCAL_ASSERT },
        ]),
      )
      const attempt = h.telemetry.begin({ ceremony: "sign_in" })
      const running = attempt.run(() => ceremony.assert(assertRequest()))
      attempt[mark]()
      h.pageHide()
      hold.resolve()
      await running
      expect(h.sent).toEqual([])
    }
  })

  /**
   * A laptop creation over a phone: the create is issued and held; once it answers, the driver
   * chains an assertion for the key material.
   */
  function heldCreation(h: ReturnType<typeof harness>) {
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      route: "cross-device",
      prfAtCreate: false,
      aaguid: GPM_AAGUID,
      transports: ["hybrid", "internal"],
    })
    const issued = deferred()
    const hold = deferred()
    const ceremony = h.telemetry.wrap({
      create: async (request) => {
        h.telemetry.requestHook({ phase: "issued", kind: "create", request })
        issued.resolve()
        await hold.promise
        return fake.create(request)
      },
      assert: (request) => fake.assert(request),
    })
    const creation = () =>
      runPasskeyCreation(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => new Uint8Array(32),
      })
    return { fake, ceremony, creation, issued: issued.promise, answer: hold.resolve }
  }

  it("keeps a creation's chained assertion inside the attempt it abandoned", async () => {
    const h = harness()
    const { fake, ceremony, creation, issued, answer } = heldCreation(h)
    const running = h.telemetry.track({ ceremony: "create" }, creation)
    await issued
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "abandoned", prompts: "1" }),
    ])

    answer()
    const created = await running
    expect(created.chained).toBeDefined()
    expect(fake.assertRequests).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ attempt: "1" })

    // The chained assertion was not counted: the next attempt is the page's second.
    await h.telemetry.track({ ceremony: "sign_in" }, () =>
      ceremony.assert(assertRequest({ credentialIds: [created.created.credentialId] })),
    )
    expect(h.sent.map((event) => [event.ceremony, event.outcome, event.attempt])).toEqual([
      ["create", "abandoned", "1"],
      ["sign_in", "succeeded", "2"],
    ])
  })

  it("counts the ceremony a handle runs after the page came back", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: GPM_AAGUID,
    })
    const ceremony = h.telemetry.wrap(fake)
    // The laptop route opens its attempt at the phone steps, and asks only once the user is ready.
    const attempt = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "abandoned", prompts: "0" }),
    ])

    await attempt.run(() => ceremony.create(createRequest()))
    expect(h.sent[1]).toMatchObject({
      ceremony: "create",
      flow: "onboarding",
      outcome: "succeeded",
      provider: "google_password_manager",
      credential_created: "yes",
      prompts: "1",
      attempt: "1",
    })
    expect(h.sent).toHaveLength(2)
  })

  it("keeps a replaced creation's chained assertion silent after the page went", async () => {
    const h = harness()
    const { ceremony, creation, issued, answer } = heldCreation(h)
    const attempt = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
    const running = attempt.run(creation)
    await issued
    attempt.superseded()
    h.pageHide()
    answer()
    const created = await running
    expect(created.chained).toBeDefined()
    expect(h.sent).toEqual([])

    await h.telemetry.track({ ceremony: "sign_in" }, () =>
      ceremony.assert(assertRequest({ credentialIds: [created.created.credentialId] })),
    )
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "sign_in", outcome: "succeeded", attempt: "2" }),
    ])
  })

  it("listens on the page itself by default", () => {
    const sent: PasskeyCeremonyProps[] = []
    const telemetry = createPasskeyTelemetry({ send: (props) => void sent.push(props) })
    telemetry.begin({ ceremony: "create" })
    window.dispatchEvent(new Event("pagehide"))
    expect(sent).toEqual([expect.objectContaining({ ceremony: "create", outcome: "abandoned" })])
  })
})

describe("snapshot", () => {
  it("names the provider of the credential the latest request targeted", async () => {
    const h = harness({ fallbackProvider: () => "1password" })
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
    })
    const ceremony = h.telemetry.wrap(fake)
    const provider = () => h.telemetry.snapshot().provider
    expect(provider()).toBe("1password")

    const a = await ceremony.create(createRequest())
    expect(provider()).toBe("icloud_keychain")
    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId] }))
    expect(provider()).toBe("icloud_keychain")

    fake.opts.assertOverride = () => a.credentialId
    await ceremony.assert(assertRequest({ credentialIds: ["credential-b"] }))
    expect(provider()).toBe("unknown")

    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId] }))
    fake.opts.assertOverride = () => {
      throw new TypeError("x")
    }
    await caught(ceremony.assert(assertRequest({ credentialIds: ["credential-b"] })))
    expect(provider()).toBe("unknown")

    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId] }))
    expect(provider()).toBe("icloud_keychain")
    fake.opts.assertOverride = () => {
      throw new DOMException("Dismissed", "NotAllowedError")
    }
    await caught(ceremony.assert(assertRequest()))
    expect(provider()).toBe("unknown")

    fake.opts.aaguid = GPM_AAGUID
    const b = await ceremony.create(createRequest())
    expect(provider()).toBe("google_password_manager")
    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId, b.credentialId] }))
    expect(provider()).toBe("unknown")
    await ceremony.assert(assertRequest({ credentialIds: [b.credentialId] }))
    expect(provider()).toBe("google_password_manager")
  })

  it("is unknown while a creation waits for its answer, and keeps a creation that failed to decode", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: hold.promise, answer: QR_CREATE, error: new TypeError("decode") },
      ]),
    )
    const creating = caught(ceremony.create(createRequest()))
    expect(h.telemetry.snapshot().provider).toBe("unknown")
    hold.resolve()
    await creating
    expect(h.telemetry.snapshot().provider).toBe("icloud_keychain")
  })

  it("stops asking for the fallback once any request is issued", async () => {
    const fallbackProvider = vi.fn(() => "yubikey" as const)
    const h = harness({ fallbackProvider })
    expect(h.telemetry.snapshot().provider).toBe("yubikey")
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { error: new DOMException("Dismissed", "NotAllowedError") },
      ]),
    )
    await caught(ceremony.assert(assertRequest()))
    fallbackProvider.mockClear()
    expect(h.telemetry.snapshot().provider).toBe("unknown")
    expect(fallbackProvider).not.toHaveBeenCalled()
  })

  it("carries the environment, from the user agent until the full read resolves", async () => {
    const full = deferred<PasskeyTelemetryEnvironment>()
    const h = harness({ environment: () => full.promise })
    expect(h.telemetry.snapshot()).toEqual({
      posture: "laptop",
      userAgent: parseUserAgent({ userAgent: CHROME_MAC }),
      provider: "unknown",
    })
    full.resolve(HINTED_MAC)
    await full.promise
    expect(h.telemetry.snapshot()).toEqual({ ...HINTED_MAC, provider: "unknown" })
  })

  it("learns from a request it did not wrap, without counting it", async () => {
    const h = harness()
    const bare = new FakePasskeyCeremony({ onRequest: h.telemetry.requestHook, aaguid: GPM_AAGUID })
    await bare.create(createRequest())
    expect(h.telemetry.snapshot().provider).toBe("google_password_manager")
    expect(h.sent).toEqual([])
  })
})

describe("never in the way", () => {
  it("settles as the run does when sending throws", async () => {
    const h = harness({
      send: () => {
        throw new Error("transport down")
      },
    })
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: LOCAL_ASSERT },
        { error: new TypeError("x") },
      ]),
    )
    expect(
      (await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest())))
        .credentialId,
    ).toBe("cred-1")
    await expect(
      h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest())),
    ).rejects.toThrow(TypeError)
    const rejecting = harness({ send: () => Promise.reject(new Error("transport down")) as never })
    rejecting.telemetry
      .begin({ ceremony: "create" })
      .end({ outcome: "failed", reason: "constraint" })
  })

  it("sends with the user agent alone when the full environment never arrives", async () => {
    const h = harness({
      environment: () => new Promise(() => {}),
      syncEnvironment: () => ({
        posture: "phone",
        userAgent: parseUserAgent({ userAgent: SAFARI_IPHONE }),
      }),
    })
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
    expect(h.sent).toEqual([
      expect.objectContaining({
        device_class: "phone",
        os: "ios",
        os_major: 18,
        browser: "safari",
        browser_major: 26,
      }),
    ])
  })

  it("survives every environment and fallback failing", async () => {
    const h = harness({
      environment: () => {
        throw new Error("no hints")
      },
      syncEnvironment: () => {
        throw new Error("no navigator")
      },
      fallbackProvider: () => {
        throw new Error("no storage")
      },
    })
    await Promise.resolve()
    expect(h.telemetry.snapshot().provider).toBe("unknown")
    h.telemetry.begin({ ceremony: "create" }).end({ outcome: "failed", reason: "constraint" })
    expect(h.sent).toEqual([expect.objectContaining({ device_class: "laptop", os: "unknown" })])
  })

  it("ignores a signal it cannot read", () => {
    const { telemetry } = harness()
    expect(() => telemetry.requestHook(undefined as never)).not.toThrow()
    expect(() =>
      telemetry.requestHook({ phase: "answered", kind: "create" } as never),
    ).not.toThrow()
  })
})

describe("over the browser ceremony", () => {
  const timing: CeremonyTiming = {
    handoffWaitMs: 30,
    teardownWaitMs: 5,
    focusWaitMs: 10,
    pendingRetryDelaysMs: [1, 1, 1, 1],
    createTimeoutMs: 50,
  }
  const get = vi.fn()
  const create = vi.fn()

  beforeEach(() => {
    get.mockReset()
    create.mockReset()
    Object.defineProperty(navigator, "credentials", { value: { get, create }, configurable: true })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
  })

  const assertionCredential = () => ({
    id: "cred-1",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: {
      signature: new Uint8Array([1, 2, 3]).buffer,
      authenticatorData: new Uint8Array(37).buffer,
      clientDataJSON: new Uint8Array([4, 5]).buffer,
    },
  })
  const pending = () => new DOMException("A request is already pending.", "NotAllowedError")
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it("counts no prompt for a call cancelled while it waits its turn", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(new BrowserPasskeyCeremony(timing, h.telemetry.requestHook))
    let settleFirst!: (credential: unknown) => void
    get.mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)))

    await h.telemetry.track({ ceremony: "sign_in" }, async () => {
      const first = ceremony.assert(assertRequest())
      const cancel = new AbortController()
      const second = ceremony.assert(assertRequest({ signal: cancel.signal }))
      await sleep(2)
      cancel.abort(new DOMException("the user cancelled", "AbortError"))
      await expect(second).rejects.toThrow(/the user cancelled/)
      settleFirst(assertionCredential())
      return first
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", prompts: "1", route: "same_device" }),
    ])
  })

  it("counts a re-issue as the same prompt, timed from its first issue", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(new BrowserPasskeyCeremony(timing, h.telemetry.requestHook))
    get.mockImplementationOnce(() => {
      h.advance(5_000)
      return Promise.reject(pending())
    })
    get.mockImplementationOnce(() => {
      h.advance(500)
      return Promise.resolve(assertionCredential())
    })
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
    expect(get).toHaveBeenCalledTimes(2)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", prompts: "1", elapsed: "1_10s" }),
    ])
  })

  it("keeps the provider of a creation that answered and then failed to decode", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(new BrowserPasskeyCeremony(timing, h.telemetry.requestHook))
    // Flags: attested data and backup eligible; then the iCloud id.
    const authData = new Uint8Array(37 + 16)
    authData[32] = 0x40 | 0x08
    authData.set(hexToBytes(APPLE_ICLOUD_AAGUID.replace(/-/g, "")), 37)
    const decodeError = new TypeError("detached ArrayBuffer")
    create.mockResolvedValue({
      id: "cred-1",
      authenticatorAttachment: "cross-platform",
      getClientExtensionResults: () => ({}),
      response: {
        get attestationObject(): never {
          throw decodeError
        },
        getAuthenticatorData: () => authData.buffer,
        getTransports: () => ["hybrid", "internal"],
      },
    })

    const error = await caught(
      h.telemetry.track({ ceremony: "create" }, () => ceremony.create(createRequest())),
    )
    expect(error).toBe(decodeError)
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "after_prompt",
        provider: "icloud_keychain",
        credential_created: "yes",
        route: "phone_qr",
        backup_eligible: "yes",
        prompts: "1",
      }),
    ])
    expect(h.telemetry.snapshot().provider).toBe("icloud_keychain")
    expect(JSON.stringify(h.sent)).not.toMatch(/detached|cred-1|fbfc3007/)
  })
})

describe("the drivers over a wrapped ceremony", () => {
  it("run as they do over the bare fake, and are counted", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      route: "cross-device",
      prfAtCreate: false,
      createAuthData: false,
      aaguid: GPM_AAGUID,
      transports: ["hybrid", "internal"],
    })
    const ceremony = h.telemetry.wrap(fake)
    const challenge = new Uint8Array(32).fill(9)

    const created = await h.telemetry.track({ ceremony: "create" }, () =>
      runPasskeyCreation(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => challenge,
      }),
    )
    expect(created.chained).toBeDefined()
    expect(created.slot).toBe("first")
    expect(bytesToHex(created.prfOutput)).toBe(
      bytesToHex(fake.prfFor(created.created.credentialId, "first")),
    )
    expect(fake.creates[0]).toMatchObject({ authenticatorAttachment: "cross-platform" })
    expect(fake.assertRequests[0]).toMatchObject({
      credentialIds: [created.created.credentialId],
      challenge,
    })

    const controller = new AbortController()
    fake.opts.route = "local"
    const refused = h.telemetry.track({ ceremony: "sign_in" }, () =>
      runPasskeyAssertion(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        challenge,
        credentialIds: [created.created.credentialId],
        signal: controller.signal,
      }),
    )
    await expect(refused).rejects.toMatchObject({ name: "PhoneRequiredError" })
    expect(fake.assertRequests[1]!.signal).toBe(controller.signal)

    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "succeeded",
        provider: "google_password_manager",
        credential_created: "yes",
        route: "phone_qr",
        prompts: "2+",
        attempt: "1",
      }),
      expect.objectContaining({
        ceremony: "sign_in",
        outcome: "refused",
        reason: "phone_required",
        route: "same_device",
        prompts: "1",
        attempt: "2",
      }),
    ])
  })
})

describe("a browser that labels another device's answer as this one's", () => {
  const safariMac = (version: string): PasskeyTelemetryEnvironment => ({
    posture: "laptop",
    userAgent: parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
        `(KHTML, like Gecko) Version/${version} Safari/605.1.15`,
    }),
  })

  const on = (version: string) => {
    const environment = safariMac(version)
    return harness({
      environment: () => Promise.resolve(environment),
      syncEnvironment: () => environment,
    })
  }

  /** Safari's label on a phone or key answer inside the window: this laptop's own. */
  const MISLABELLED_ASSERT: PasskeyAnswerEvidence = {
    authenticatorAttachment: "platform",
    backupEligible: true,
  }
  const MISLABELLED_CREATE: PasskeyAnswerEvidence = {
    authenticatorAttachment: "platform",
    backupEligible: true,
    aaguid: APPLE_ICLOUD_AAGUID,
    transports: ["hybrid", "internal"],
  }

  const signIn = async (h: ReturnType<typeof harness>, answer: PasskeyAnswerEvidence) => {
    const ceremony = h.telemetry.wrap(scripted(h.telemetry.requestHook, h.advance, [{ answer }]))
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
  }

  it("reports a sign-in it mislabels as the phone that answered", async () => {
    const h = on("18.6")
    await signIn(h, MISLABELLED_ASSERT)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", route: "phone_qr", browser: "safari" }),
    ])
  })

  it("reports a sign-in a security key answered as a security key", async () => {
    const h = on("18.6")
    await signIn(h, { ...MISLABELLED_ASSERT, backupEligible: false })
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", route: "security_key" }),
    ])
  })

  it("reports a creation it mislabels as the phone over QR", async () => {
    const h = on("18.6")
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: MISLABELLED_CREATE }]),
    )
    await h.telemetry.track({ ceremony: "create" }, () =>
      ceremony.create({ ...createRequest(), authenticatorAttachment: "cross-platform" }),
    )
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        credential_created: "yes",
        route: "phone_qr",
      }),
    ])
  })

  it("takes a build outside the window at its word", async () => {
    const above = on("26.4")
    await signIn(above, MISLABELLED_ASSERT)
    const below = on("18.5")
    await signIn(below, MISLABELLED_ASSERT)
    const chrome = harness()
    await signIn(chrome, MISLABELLED_ASSERT)
    for (const h of [above, below, chrome]) {
      expect(h.sent).toEqual([expect.objectContaining({ route: "same_device" })])
    }
  })

  it("leaves a phone alone, where the label is not in doubt", async () => {
    const environment: PasskeyTelemetryEnvironment = {
      posture: "phone",
      userAgent: parseUserAgent({ userAgent: SAFARI_IPHONE }),
    }
    const h = harness({
      environment: () => Promise.resolve(environment),
      syncEnvironment: () => environment,
    })
    await signIn(h, MISLABELLED_ASSERT)
    expect(h.sent).toEqual([
      expect.objectContaining({ route: "same_device", device_class: "phone" }),
    ])
  })
})
