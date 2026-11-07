// The signup flow over a real session: its passkey attempts, its lifecycle and its exits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fixed } from "@obsidion/front-core"

import {
  createPasskeyTelemetry,
  type PasskeyCeremonyProps,
  type PasskeyRequestScope,
} from "@obsidion/passkey-web"
import {
  openSignupFlow,
  type SignupInputs,
} from "../../../src/features/onboarding/OnboardingScreen/signupFlow"
import type { GateResult } from "../../../src/features/identity/ceremonyGate"
import { scopeOfStatus } from "../../../src/platform/auth/passkeyAttemptScope"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import { closeSession } from "../../../src/session/session"
import { __resetPreBootTapsForTests, setPreBootCreate } from "../../../src/ui/preBootTaps"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { testCore } from "../../support/page"
import {
  pageHide,
  passkeyTelemetryHarness,
  type HeldRequest,
} from "../../support/passkeyTelemetryHarness"
import { pendingRecord, seedRegistration } from "../../support/registrationFixtures"
import type { PaylinkKit } from "../../../src/features/paylink/usePaylinkDeps"
import { seedBootConfig } from "../../support/seedBootConfig"
import { openTestSession } from "../../support/session"
import { setIdentity } from "../../support/identity"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const LAPTOP: GateResult = {
  choice: "computer",
  route: "this-device",
  reach: "ok",
  creation: { local: false, chromeTip: false },
  signal: new AbortController().signal,
}
/** The account a create builds; collecting its keys fails, which is no part of these tests. */
const built = { getAddress: () => ({ toString: () => `0x${"ab".repeat(32)}` }) }

let events: PasskeyCeremonyProps[]
let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
let ended: AbortController

beforeEach(async () => {
  await seedBootConfig()
  __resetPreBootTapsForTests()
  sessionStorage.clear()
  events = []
})
afterEach(() => {
  ended?.abort()
  pageHide()
  closeSession()
})

/** A flow over the test session; every outside call is a spy or the test's own. */
async function open(
  drawTag = vi.fn(async () => ({ tag: "drawn", grantToken: "g" })),
  draftTag?: string,
) {
  const own = openTestSession({
    wallet: { networkId: "0xnet" },
    auth: { useLaptopCreation: vi.fn(), recoverFromCache: async () => undefined },
  })
  await own.registrations.ready
  const telemetry = createPasskeyTelemetry({ send: (props) => void events.push(props) })
  harness = await passkeyTelemetryHarness(telemetry)
  const io = {
    telemetry: () => telemetry,
    fire: vi.fn(),
    fireOnboarding: vi.fn(),
    landing: vi.fn(),
    report: vi.fn(),
    drawTag,
    getClaimStatus: vi.fn(async (): Promise<"reserved" | "claimed"> => "reserved"),
    createAccount: vi.fn(),
    viewLink: vi.fn(async () => ({ flavor: "direct" })),
    claimLink: vi.fn(async () => {}),
    ticketActivation: vi.fn(() => ({ state: "ready", stash: { fragment: "frag" } })),
  }
  const gate = { gate: vi.fn(async () => LAPTOP), cancel: vi.fn(), dismiss: vi.fn() }
  const navigate = vi.fn()
  /** The screen's latest render. */
  let inputs: SignupInputs = {
    navigate,
    gate,
    ticketHeld: false,
    embedded: draftTag !== undefined,
    draftTag,
    ticketSignup: false,
    pathname: "/claim",
    params: new URLSearchParams(),
  }
  const flow = openSignupFlow({ own, io: io as never }, () => inputs)
  /** A rerender: a new inputs object, as the screen makes each render. */
  const rerender = (patch: Partial<SignupInputs>) => void (inputs = { ...inputs, ...patch })
  ended = new AbortController()
  flow.start(ended.signal)
  return { flow, io, gate, navigate, own, rerender }
}

/** The next create asks the browser once and waits for the test. */
function heldCreate(io: { createAccount: ReturnType<typeof vi.fn> }) {
  const held: { request?: HeldRequest; signal?: AbortSignal } = {}
  io.createAccount.mockImplementationOnce(
    async (
      _d: unknown,
      _t: unknown,
      status: unknown,
      _h: unknown,
      opts: { signal: AbortSignal },
    ) => {
      held.signal = opts.signal
      held.request = harness.request(
        "create",
        undefined,
        scopeOfStatus(status) as PasskeyRequestScope,
      )
      await held.request.settled
      return built
    },
  )
  return held
}

describe("the signup's passkey attempts", () => {
  it("keep a create cancelled mid-request the user's cancel when the next one finishes first", async () => {
    const { flow, io } = await open()
    const first = heldCreate(io)
    flow.leaveTerms(true)
    await flush()
    flow.closeToInvite()
    expect(first.signal?.aborted).toBe(true)
    const second = heldCreate(io)
    flow.leaveTerms(true)
    await flush()
    second.request!.answer()
    await flush()
    first.request!.reject(new DOMException("closed", "NotAllowedError"))
    await flush()
    expect(events).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "succeeded", attempt: "2" }),
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", attempt: "1" }),
    ])
  })

  it("carry the phone check a laptop create's gate made", async () => {
    const { flow, io } = await open()
    const held = heldCreate(io)
    flow.leaveTerms(true)
    await flush()
    held.request!.answer()
    await flush()
    expect(events).toEqual([expect.objectContaining({ outcome: "succeeded", phone_reach: "ok" })])
  })

  it("end with the screen, which reports no failed create whatever the request then throws", async () => {
    const { flow, io } = await open()
    io.createAccount.mockImplementationOnce(
      (_d: unknown, _t: unknown, _s: unknown, _h: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          opts.signal.addEventListener("abort", () => reject(new Error("unreadable answer"))),
        ),
    )
    flow.leaveTerms(true)
    await flush()
    ended.abort()
    await flush()
    expect(io.fire.mock.calls.filter(([name]) => name === "action_failed")).toEqual([])
  })

  it("replace one waiting at the gate quietly, and the user's cancel still lands", async () => {
    const { flow, gate } = await open()
    gate.gate.mockImplementation(() => new Promise(() => {}))
    flow.leaveTerms(true)
    await flush()
    flow.leaveTerms(true)
    await flush()
    expect(events).toEqual([])
    flow.closeToInvite()
    pageHide()
    await flush()
    expect(events).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "0" }),
    ])
  })

  it("keep the warning of a pick the sheet took, and start any other run clean", async () => {
    const { flow, gate } = await open()
    gate.gate.mockImplementation(() => new Promise(() => {}))
    const warning = "w"
    flow.chooseOnSheet("computer", ["gpm"], warning)
    expect(flow.state.get()).toMatchObject({ creationWarning: warning, modalBusy: true })
    await flush()
    flow.leaveTerms(true)
    expect(flow.state.get().creationWarning).toBeUndefined()
  })
})

describe("the signup's lifecycle", () => {
  it("takes the tap before boot once, in the start a replay keeps, and reports its landing once", async () => {
    setPreBootCreate(true)
    const { flow, io } = await open()
    // The first start is StrictMode's: aborted before its microtask runs.
    ended.abort()
    const replay = new AbortController()
    flow.start(replay.signal)
    await flush()
    const attempted = io.fireOnboarding.mock.calls.filter(
      ([e]) => e === "onboarding_create_attempted",
    )
    expect(attempted).toHaveLength(1)
    expect(io.landing).toHaveBeenCalledTimes(1)
    replay.abort()
  })

  it("holds the endpoints while a draw runs, and lets go when it lands or is cancelled", async () => {
    let drawn!: (v: { tag: string; grantToken: string }) => void
    const { flow, navigate } = await open(
      vi.fn(() => new Promise<{ tag: string; grantToken: string }>((r) => (drawn = r))),
    )
    void flow.createDrawnWallet()
    await flush()
    expect(flow.state.get().inviteBusy).toBe(true)
    drawn({ tag: "drawn", grantToken: "g" })
    await flush()
    expect(flow.state.get().inviteBusy).toBe(false)
    expect(navigate).toHaveBeenCalledWith("/")
    void flow.createDrawnWallet()
    flow.cancelUnlock()
    expect(flow.state.get().inviteBusy).toBe(false)
  })

  it("keeps the tag Home shows now, not the one it opened on", async () => {
    const { flow, rerender } = await open(
      vi.fn(async () => ({ tag: "shuffled", grantToken: "g2" })),
      "drawn",
    )
    await flow.rerollDrawnTag()
    rerender({ draftTag: "shuffled" })
    flow.keepDrawnTag()
    expect(flow.state.get()).toMatchObject({ handle: "shuffled", chosenTag: "shuffled" })
  })

  it("says a checked tag is taken, and goes on to the terms for a free one", async () => {
    const { flow, io } = await open()
    io.getClaimStatus.mockResolvedValueOnce("claimed")
    await flow.unlockAccess("Alice")
    expect(flow.state.get()).toMatchObject({ inviteNote: { kind: "taken", handle: "alice" } })
    await flow.unlockAccess("bob")
    expect(flow.state.get()).toMatchObject({ step: "terms", handle: "bob", inviteBusy: false })
    expect(io.fireOnboarding).toHaveBeenCalledWith("onboarding_handle_checked", {
      status: "available",
    })
  })
})

describe("the pending step's exits", () => {
  const account = async (msk: string | null = "0x01") => {
    await writeDeviceKeys(testCore().database, { storageId: "a1", msk })
    const record = pendingRecord({ phase: "awaiting_deposit" })
    await seedRegistration(record)
    return record
  }

  it("wakes the session to name a funded record's tag, then enters once", async () => {
    const record = await account()
    const { flow, navigate, own } = await open()
    const wake = vi.spyOn(own, "wake")
    expect(flow.state.get().step).toBe("pending")
    await seedRegistration({ ...record, phase: "funded", fundedAt: 1 })
    await flush()
    expect(wake).toHaveBeenCalledWith(own.tasks.registrationIdentity)
    await vi.waitFor(() => expect(own.identity.get().value?.handle).toBe(record.tag))
    await setIdentity({ handle: record.tag, address: record.l2Address, claimedAt: 2 })
    await flush()
    // No passkey record opened it here: the account is recovered on /enter.
    expect(navigate.mock.calls).toEqual([[`/enter?handle=${record.tag}`, { replace: true }]])
  })

  it("sends a signed-out tab's settled record to sign-in, where its key comes back", async () => {
    const record = await account(null)
    const { navigate } = await open()
    await seedRegistration({ ...record, phase: "funded", fundedAt: 1 })
    await flush()
    expect(navigate).toHaveBeenCalledWith(`/enter?handle=${record.tag}`, { replace: true })
  })

  it("claims a stashed link with the kit that arrived after it opened", async () => {
    await writeDeviceKeys(testCore().database, { storageId: "a1", msk: "0x01" })
    await seedRegistration(pendingRecord())
    const { flow, io, rerender, own } = await open()
    Object.defineProperty(own, "account", { value: fixed("account", { getAddress: () => "0xa" }) })
    rerender({ paylinkKit: { kit: true } as unknown as PaylinkKit })
    await flow.settlePendingPaylink()
    expect(io.report).not.toHaveBeenCalled()
    expect(io.viewLink).toHaveBeenCalledWith(expect.objectContaining({ kit: true }), "frag")
  })

  it("steers a failed record back to the invitation", async () => {
    const record = await account()
    const { flow, navigate } = await open()
    await seedRegistration({ ...record, phase: "failed_terminal" })
    await flush()
    expect(flow.state.get()).toMatchObject({ step: "invite", inviteNote: { kind: "failed" } })
    expect(navigate).toHaveBeenCalledWith("/claim", { replace: true })
  })

  it("reports a signup's completion once, before a save that fails, and enters on the retry", async () => {
    await account()
    const { flow, io, navigate } = await open()
    testWalletDbs().onApply = () => {
      throw new Error("disk full")
    }
    await flow.enterPastClaim("taga")
    testWalletDbs().onApply = undefined
    expect(flow.state.get().entryFailed).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
    flow.retryEntry()
    await vi.waitFor(() => expect(flow.state.get().entryFailed).toBe(false))
    const completed = io.fireOnboarding.mock.calls.filter(([e]) => e === "onboarding_completed")
    expect(completed).toHaveLength(1)
    expect(navigate).toHaveBeenCalled()
  })
})
