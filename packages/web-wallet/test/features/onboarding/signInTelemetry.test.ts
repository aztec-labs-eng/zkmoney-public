// @vitest-environment node
// One `passkey_ceremony` per sign-in, read from what the sign-in returned or threw.
import { beforeEach, describe, expect, it } from "vitest"
import { StoredAddressMismatchError } from "@obsidion/front-core"
import {
  createPasskeyTelemetry,
  type PasskeyCeremonyProps,
  type PasskeyRequestScope,
  type PasskeyTelemetry,
} from "@obsidion/passkey-web"
import {
  openSignInFlow,
  SIGN_IN_IO,
} from "../../../src/features/onboarding/EnterAppScreen/signInFlow"
import { passkeyTelemetry } from "../../../src/lib/passkeyTelemetry"
import { seedDeviceKeys } from "../../support/page"
import { passkeyTelemetryHarness, type HeldRequest } from "../../support/passkeyTelemetryHarness"
import {
  confirmResult,
  flush,
  L2,
  named,
  nameless,
  OTHER,
  resolved,
  unknownResult,
} from "../../support/signIn"
import { signInSuite } from "../../support/signInFlow"

const open = signInSuite()
let events: PasskeyCeremonyProps[]
let pageHide: EventTarget
let telemetry: PasskeyTelemetry
let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>

beforeEach(async () => {
  events = []
  pageHide = new EventTarget()
  telemetry = createPasskeyTelemetry({
    send: (props) => void events.push(props),
    pageHideTarget: pageHide,
    // The wallet tracker's reading of its record error (test/lib/passkeyTelemetry.test.ts).
    extraNames: { StoredAddressMismatchError: { outcome: "refused", reason: "passkey_mismatch" } },
  })
  harness = await passkeyTelemetryHarness(telemetry)
})

type Options = { own?: PasskeyRequestScope; signal: AbortSignal }
type Opened = Awaited<ReturnType<typeof open>>

/** The flow at `/enter?<search>` over this test's tracker, once its arrival settled. */
async function arrive(search = "", prepare: (opened: Opened) => void = () => {}) {
  const opened = await open(search, { start: false })
  prepare(opened)
  const io = { ...opened.io, telemetry: () => telemetry }
  const params = new URLSearchParams(search)
  const flow = openSignInFlow(
    { session: opened.session, origin: "http://localhost:3000", io: io as never },
    () => ({ navigate: opened.navigate, params, gate: opened.gate }),
  )
  flow.start(opened.ended.signal)
  await flush()
  return { ...opened, flow }
}
/** The screen with @alice read off L1, so Login is the pinned sign-in. */
const found = () => arrive("handle=alice", ({ io }) => io.lookup.mockResolvedValue(resolved()))
/** A sign-in whose one request is answered at once, then ends in `outcome`. */
const answered = (opened: Opened, outcome: () => unknown) =>
  opened.io.enterWithPasskey.mockImplementationOnce(async (...args: unknown[]) => {
    await harness.answered("assert", (args[3] as Options).own)
    return outcome()
  })
/** A sign-in that asks once and waits for the test. */
const held = (opened: Opened) => {
  const entry: { request?: HeldRequest } = {}
  opened.io.enterWithPasskey.mockImplementationOnce(async (...args: unknown[]) => {
    const { signal, own } = args[3] as Options
    entry.request = harness.request("assert", signal, own)
    await entry.request.settled
    return unknownResult()
  })
  return entry
}

describe("the sign-in's own IO", () => {
  it("reports to the page's passkey telemetry", () => {
    expect(SIGN_IN_IO.telemetry()).toBe(passkeyTelemetry)
  })
})

describe("the arrival probe", () => {
  it("restoring a cached key, or needing a prompt, reports nothing: it asked for nothing", async () => {
    const entering = await arrive("", ({ io }) =>
      io.enterWithPasskey.mockResolvedValueOnce(named()),
    )
    expect(entering.navigate).toHaveBeenCalledWith("/", { replace: true })
    const screen = await arrive()
    expect(screen.flow.state.get().shown).toBe(true)
    expect(events).toEqual([])
  })

  it("refused by this browser's record reports the refusal with no prompt", async () => {
    const { flow } = await arrive("", ({ io }) =>
      io.enterWithPasskey.mockRejectedValueOnce(new StoredAddressMismatchError()),
    )
    expect(flow.state.get().refusal?.name).toBe("StoredAddressMismatchError")
    expect(events).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "refused",
        reason: "passkey_mismatch",
        prompts: "0",
      }),
    ])
  })
})

describe("a prompted sign-in", () => {
  it.each([
    ["an entered account", () => named(), { outcome: "succeeded" }],
    ["a tag to confirm", confirmResult, { outcome: "succeeded" }],
    [
      "no wallet for the passkey",
      () => ({ entered: false, reason: "unknown" }),
      { outcome: "refused", reason: "no_wallet_for_passkey" },
    ],
  ])("Show passkeys ending in %s reports it", async (_l, result, expected) => {
    const opened = await arrive()
    answered(opened, result)
    opened.flow.showPasskeys()
    await flush()
    expect(events).toEqual([
      expect.objectContaining({ ceremony: "sign_in", flow: "enter", prompts: "1", ...expected }),
    ])
  })

  it("a nameless account succeeds, and the card after it sends no passkey event", async () => {
    const opened = await arrive()
    answered(opened, () => nameless(opened.session))
    opened.flow.showPasskeys()
    await flush()
    expect(opened.flow.state.get().refusal?.name).toBe("GrantedRegistrationError")
    expect(events).toEqual([expect.objectContaining({ outcome: "succeeded" })])
  })

  it.each([
    [
      "a record the registry could not confirm",
      () => unknownResult({ addresses: [L2] }),
      { outcome: "failed", reason: "registry_unconfirmed" },
    ],
    [
      "a key that is not the tag's",
      () => unknownResult({ addresses: [OTHER] }),
      { outcome: "refused", reason: "passkey_mismatch" },
    ],
  ])("a pinned sign-in ending in %s reports it", async (_l, outcome, expected) => {
    const opened = await found()
    answered(opened, outcome)
    opened.flow.login()
    await flush()
    expect(events).toEqual([
      expect.objectContaining({ ceremony: "sign_in", flow: "enter", prompts: "1", ...expected }),
    ])
  })

  it("the card's retry is a fresh attempt, counted as this page's second", async () => {
    const opened = await found()
    answered(opened, () => unknownResult({ addresses: [L2] }))
    opened.flow.login()
    await flush()
    answered(opened, () => named())
    opened.flow.rerun()
    await flush()
    expect(events).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "registry_unconfirmed", attempt: "1" }),
      expect.objectContaining({ outcome: "succeeded", prompts: "1", attempt: "2" }),
    ])
  })
})

describe("an attempt that ends early", () => {
  it("Cancel sign-in during the request sends one cancel, and nothing once the screen and page go", async () => {
    const opened = await arrive()
    const entry = held(opened)
    opened.flow.showPasskeys()
    await flush()
    expect(entry.request).toBeDefined()
    opened.flow.cancel()
    await flush()
    opened.ended.abort()
    pageHide.dispatchEvent(new Event("pagehide"))
    await flush()
    expect(events).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
  })

  it("leaving the screen during the request sends nothing, then or when the page goes", async () => {
    const opened = await arrive()
    const entry = held(opened)
    opened.flow.showPasskeys()
    await flush()
    expect(entry.request).toBeDefined()
    opened.ended.abort()
    pageHide.dispatchEvent(new Event("pagehide"))
    await flush()
    expect(events).toEqual([])
  })

  it("a sign-in that replaces the document has reported before it does", async () => {
    await seedDeviceKeys({ storageId: "storage-a" })
    const opened = await arrive()
    let sentBefore: number | undefined
    opened.io.leave.mockImplementationOnce(async () => void (sentBefore = events.length))
    answered(opened, async () => {
      await seedDeviceKeys({ storageId: "storage-b" })
      return named()
    })
    opened.flow.showPasskeys()
    await flush()
    expect(opened.io.leave).toHaveBeenCalledWith("/enter?named=alice")
    expect(events).toEqual([expect.objectContaining({ outcome: "succeeded" })])
    expect(sentBefore).toBe(1)
  })
})
