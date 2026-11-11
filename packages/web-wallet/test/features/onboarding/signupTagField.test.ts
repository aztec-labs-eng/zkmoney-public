// @vitest-environment node
/** The signup's tag field: what is typed, and the probe its step runs, over a real session. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { composeWireNameHash } from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  openSignupFlow,
  type SignupInputs,
} from "../../../src/features/onboarding/OnboardingScreen/signupFlow"
import { stashTicketSignup } from "../../../src/features/paylink/claimStash"
import { tabStash } from "../../../src/platform/storage/tabStash"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"

const ENS = "obsidion.eth"
const DEBOUNCE = 350

/** The service's answer per tag, and each probe it saw. */
let answers: Record<string, string>
let probes: { tag: string; grantToken?: string }[]

const primed = { tuple: { ensDomain: ENS, rollupVersion: "1" } as OxideEnvTuple }
beforeEach(() => {
  vi.useFakeTimers()
  const tab = new Map<string, string>()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => tab.get(key) ?? null,
    setItem: (key: string, value: string) => void tab.set(key, value),
    removeItem: (key: string) => void tab.delete(key),
  })
  answers = {}
  probes = []
  const tagOf = (hash: string | null) =>
    Object.keys(answers).find((tag) => composeWireNameHash(tag, ENS) === hash)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const tag = tagOf(body?.nameHash ?? new URL(url).searchParams.get("nameHash"))
      if (!tag) return new Response("{}", { status: 404 })
      probes.push({ tag, ...(body?.grantToken ? { grantToken: body.grantToken } : {}) })
      return new Response(
        JSON.stringify({
          status: answers[tag],
          blocked: false,
          grantValid: true,
          grantBound: false,
        }),
      )
    }),
  )
})
afterEach(() => {
  ended?.abort()
  closeSession()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

let ended: AbortController | undefined

/** A flow over the test session; the screen's inputs patched by `over`. */
async function open(over: Partial<SignupInputs> = {}, grant?: { handle: string; token: string }) {
  const session = openTestSession({ wallet: { networkId: "0xnet" }, contractService: {}, primed })
  await session.registrations.ready
  if (grant) session.signup.stashDrawnGrant(grant.handle, grant.token)
  const inputs: SignupInputs = {
    navigate: vi.fn(),
    gate: { gate: vi.fn(), cancel: vi.fn(), dismiss: vi.fn() },
    ticketHeld: false,
    embedded: false,
    ticketSignup: false,
    pathname: "/claim",
    params: new URLSearchParams(),
    ...over,
  }
  const flow = openSignupFlow(
    {
      session,
      io: {
        fireOnboarding: vi.fn(),
        landing: vi.fn(),
        grantIsCurrent: async () => true,
        getClaimStatus: async () => "reserved" as const,
      },
    },
    () => inputs,
  )
  ended = new AbortController()
  flow.start(ended.signal)
  return { flow, field: () => flow.tagField.get() }
}

describe("the signup's tag field", () => {
  it("seeds the invitation with the route's tag and checks it before the answer lands", async () => {
    answers = { satoshi: "available" }
    const { field } = await open({ routeHandle: "satoshi" })
    expect(field()).toMatchObject({ typed: "satoshi", checking: true, status: "unknown" })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(field()).toMatchObject({ checking: false, status: "available" })
  })

  it("folds a seeded tag that never passes through the field", async () => {
    answers = { "abc-def": "available" }
    const { field } = await open({ routeHandle: "@ABC-DEF.zk.money" })
    expect(field()).toMatchObject({ typed: "abc-def", checking: true })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(probes).toEqual([{ tag: "abc-def" }])
  })

  it("folds what is typed and probes only the tag typed last", async () => {
    answers = { "abc-def": "reserved" }
    const { flow, field } = await open({ routeHandle: "x" })
    flow.typeTag("@ABC")
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1)
    flow.typeTag("@ABC-DEF")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(field()).toMatchObject({ typed: "abc-def", handle: "abc-def", status: "reserved" })
    expect(probes).toEqual([{ tag: "abc-def" }])
  })

  it("never probes a malformed tag", async () => {
    const { flow, field } = await open({ routeHandle: "x" })
    flow.typeTag("not a tag!")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(field()).toMatchObject({ handle: null, checking: false })
    expect(probes).toEqual([])
  })

  it("sends a route grant only with its own route's tag", async () => {
    answers = { admin: "blocked", other: "available" }
    const { flow, field } = await open({ routeHandle: "admin" }, { handle: "admin", token: "g" })
    expect(field().grantToken).toBe("g")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    flow.typeTag("other")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(field().grantToken).toBeUndefined()
    expect(probes).toEqual([{ tag: "admin", grantToken: "g" }, { tag: "other" }])
  })

  it("leaves a grant for another tag off the route's probe", async () => {
    answers = { satoshi: "available" }
    const { field } = await open({ routeHandle: "satoshi" }, { handle: "admin", token: "g" })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(field().grantToken).toBeUndefined()
    expect(probes).toEqual([{ tag: "satoshi" }])
  })

  it("probes nothing while a draw stands in for the invitation", async () => {
    answers = { drawn: "available" }
    const { flow } = await open({ embedded: true, draftTag: "drawn" })
    flow.typeTag("drawn")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(probes).toEqual([])
  })

  it("probes the ticket signup's tag step, seeded with nothing", async () => {
    answers = { river: "available" }
    stashTicketSignup(tabStash, { fragment: "frag", schedule: { fee: "1", minDeposit: "2" } })
    const { flow, field } = await open({ ticketSignup: true })
    expect(flow.state.get().step).toBe("tag")
    expect(field().typed).toBe("")
    flow.typeTag("river")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(field()).toMatchObject({ status: "available", checking: false })
  })

  it("shows the claimed tag, folded, when a ticket signup steers back to the tag step", async () => {
    answers = { river: "available" }
    stashTicketSignup(tabStash, { fragment: "frag", schedule: { fee: "1", minDeposit: "2" } })
    const { flow, field } = await open({ ticketSignup: true })
    flow.typeTag("river.zk.money")
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    await flow.unlockAccess(field().typed)
    expect(flow.state.get().step).toBe("terms")
    flow.closeToInvite()
    expect(flow.state.get().step).toBe("tag")
    expect(field().typed).toBe("river")
  })
})
