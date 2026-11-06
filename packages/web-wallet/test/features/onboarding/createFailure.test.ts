// @vitest-environment node
// How a failed passkey step of the signup ends: its card, the sheet again, an error, or nothing.
import { afterEach, describe, expect, it } from "vitest"
import {
  LaptopPasskeyRefusedError,
  NoPrfError,
  PhoneRequiredError,
  markPasskeyWritten,
  recordRequestHeld,
  type LaptopCreation,
} from "@obsidion/passkey-web"
import {
  classifyCreateFailure,
  retryChoiceFor,
  type CreateAttempt,
} from "../../../src/features/onboarding/OnboardingScreen/createFailure"
import { onePasswordCreate, otherCreate } from "../../support/passkeyExtensionStubs"

const WINDOWS: LaptopCreation = {
  local: true,
  os: "windows",
  row: "windowsChrome",
  managers: ["gpm", "1password"],
  withdrawn: [],
}
const onComputer: CreateAttempt = {
  choice: "computer",
  route: "this-device",
  reach: "unknown",
  creation: WINDOWS,
}
const classify = (err: unknown, attempted?: CreateAttempt, fastRefusals = 0) =>
  classifyCreateFailure(err, { attempted, portable: false, fastRefusals })
const closed = () => new DOMException("closed", "NotAllowedError")
/** Refused before any prompt could open: another passkey dialog held the request. */
const refusedAtOnce = () => {
  const refused = closed()
  recordRequestHeld(refused, 200)
  return refused
}

describe("a create the browser closed with nothing made", () => {
  it("re-opens the sheet on the option it ran, and leaves a phone on its button", () => {
    expect(classify(closed(), { ...onComputer, ticketAttemptId: "t1" })).toEqual({
      failure: { kind: "reopen", openOn: "computer", reopened: "unfinished", restart: "t1" },
      fastRefusals: 0,
    })
    expect(classify(closed(), { reach: "unknown" }).failure).toEqual({ kind: "silent" })
  })

  it("says to close other passkey windows, then from the second in a row another browser", () => {
    const first = classify(refusedAtOnce(), onComputer)
    expect(first).toMatchObject({ failure: { reopened: "blocked" }, fastRefusals: 1 })
    const second = classify(refusedAtOnce(), onComputer, first.fastRefusals)
    expect(second).toMatchObject({ failure: { reopened: "blocked-again" }, fastRefusals: 2 })
    expect(classify(closed(), onComputer, 2).fastRefusals).toBe(0)
  })

  it("lands on the card once the passkey was made, whatever its speed", () => {
    const { failure } = classify(markPasskeyWritten(refusedAtOnce()), onComputer)
    expect(failure).toMatchObject({ kind: "refusal", refusal: { leftover: true } })
  })
})

describe("a refusal card", () => {
  const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
  const install = (create: unknown) =>
    Object.defineProperty(navigator, "credentials", { value: { create }, configurable: true })
  afterEach(() => {
    if (credentials) Object.defineProperty(navigator, "credentials", credentials)
    else delete (navigator as { credentials?: unknown }).credentials
  })
  const noKey = (manager: "1password" | "gpm") =>
    markPasskeyWritten(new NoPrfError({ localManagers: ["gpm", "1password"], manager }))

  it("leads with the phone for an Apple answer refused here, with what the sheet attempted", () => {
    const err = markPasskeyWritten(new LaptopPasskeyRefusedError("apple", ["gpm"]))
    const { failure } = classify(err, onComputer)
    expect(failure).toMatchObject({
      kind: "refusal",
      toCreate: false,
      refusal: { appleRefusedHere: true, choice: "computer", leftover: true },
    })
  })

  it("advises Chrome only where the sheet said Chrome could keep the passkey", () => {
    const err = new PhoneRequiredError({ providerName: "Windows Hello", ceremony: "create" })
    const tip = { ...onComputer, creation: { ...WINDOWS, chromeTip: "gpm" as const } }
    expect(classify(err, tip).failure).toMatchObject({ refusal: { chromeAdvice: true } })
    expect(classify(err, onComputer).failure).not.toMatchObject({ refusal: { chromeAdvice: true } })
  })

  it("advises 1Password's extension on Windows, worded for the script that answers", () => {
    install(otherCreate())
    expect(classify(noKey("1password"), onComputer).failure).toMatchObject({
      refusal: { extensionAdvice: "install" },
    })
    install(onePasswordCreate())
    const { failure } = classify(noKey("1password"), onComputer)
    expect(failure).toMatchObject({ refusal: { extensionAdvice: "use" } })
    if (failure.kind === "refusal") expect(retryChoiceFor(failure.refusal)).toBe("1password")
    expect(classify(noKey("gpm"), onComputer).failure).toMatchObject({
      refusal: { extensionAdvice: undefined },
    })
    const mac: CreateAttempt = { ...onComputer, creation: { ...WINDOWS, os: "macos" } }
    expect(classify(noKey("1password"), mac).failure).toMatchObject({
      refusal: { extensionAdvice: undefined },
    })
  })

  it("takes an app's built-in browser to its own card, and the create step with it", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Instagram 300.0",
      configurable: true,
    })
    const err = new DOMException("not supported", "NotSupportedError")
    const portable = classifyCreateFailure(err, {
      attempted: onComputer,
      portable: true,
      fastRefusals: 0,
    })
    expect(portable.failure).toMatchObject({ kind: "refusal", toCreate: true })
    expect(classify(err, onComputer).failure).toMatchObject({ kind: "error" })
  })
})
