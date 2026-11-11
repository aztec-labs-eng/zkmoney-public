// @vitest-environment node
/** The tag probe over the real account-service client, with `fetch` standing in for the service. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { memoryStore } from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PageChain } from "../../../src/session/pageChain"
import {
  drawTag,
  nameCheck,
  probeNameAvailability,
  tagSubmit,
  type NameAvailability,
  type NameKey,
  type ProbePage,
  type TagField,
} from "../../../src/features/registration/nameAvailability"
import { sandboxConfig } from "../../support/seedBootConfig"
import { answered, testQuery } from "../../support/query"

const ENS = "obsidion.eth"

const answering = (body: unknown, status = 200) =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status }),
  )

let page: ProbePage
beforeAll(async () => {
  const tuple = { ensDomain: ENS, rollupVersion: "1" } as OxideEnvTuple
  const chain = { oxideTuple: answered(tuple) } as unknown as PageChain
  page = { config: await sandboxConfig(), chain, query: testQuery() }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("drawTag", () => {
  it("draws under the wire domain and returns the tag with its grant", async () => {
    const drawn = { tag: "brisk-otter", nameHash: "0x01", grantToken: "draw-token", expiresAt: 1 }
    const fetchMock = answering(drawn)
    vi.stubGlobal("fetch", fetchMock)

    expect(await drawTag(page)).toEqual(drawn)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${page.config.accountServiceUrl}/domain/draw`)
    expect(JSON.parse(String(init?.body))).toEqual({ ensDomain: ENS })
  })
})

describe("probeNameAvailability", () => {
  it("folds the tag itself, so a caller that forgets cannot probe a stray node", async () => {
    const fetchMock = answering({ status: "available" })
    vi.stubGlobal("fetch", fetchMock)
    await probeNameAvailability(page, "ABC-DEF")
    await probeNameAvailability(page, "abc-def")
    const [a, b] = fetchMock.mock.calls.map((c) => new URL(c[0]).searchParams.get("nameHash"))
    expect(a).toBe(b)
  })

  it("reads a refusal, an unrecognized status and a dead network as unknown", async () => {
    vi.stubGlobal("fetch", answering({ error: "down" }, 503))
    expect((await probeNameAvailability(page, "satoshi")).status).toBe("unknown")

    vi.stubGlobal("fetch", answering({ status: "maybe" }))
    expect((await probeNameAvailability(page, "satoshi")).status).toBe("unknown")

    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    expect((await probeNameAvailability(page, "satoshi")).status).toBe("unknown")
  })

  it("answers unknown within one timeout, however many reads the client retries", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    )
    const probe = probeNameAvailability(page, "satoshi")
    await vi.advanceTimersByTimeAsync(2000)
    expect((await probe).status).toBe("unknown")
  })
})

describe("nameCheck", () => {
  it("validates a key's grant with its probe, and reads it as checking until its own answer", async () => {
    vi.useFakeTimers()
    const fetchMock = answering({
      status: "blocked",
      blocked: true,
      grantValid: true,
      grantBound: false,
    })
    vi.stubGlobal("fetch", fetchMock)
    const key = memoryStore<NameKey | undefined>(undefined)
    const names = nameCheck(page, key)
    names.start(new AbortController().signal)
    expect(names.check.get()).toMatchObject({ status: "unknown", checking: false })

    key.set({ handle: "admin", grantToken: "grant-token" })
    expect(names.check.get().checking).toBe(true)
    await vi.advanceTimersByTimeAsync(350)
    expect(names.check.get()).toEqual({
      status: "blocked",
      checking: false,
      grantValid: true,
      grantBound: false,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      grantToken: "grant-token",
    })

    // An equal key is the same check: no second probe.
    key.set({ handle: "admin", grantToken: "grant-token" })
    await vi.advanceTimersByTimeAsync(350)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    key.set({ handle: "admin" })
    expect(names.check.get().checking).toBe(true)
  })
})

describe("tagSubmit", () => {
  const field = (status: NameAvailability, over: Partial<TagField> = {}): TagField => ({
    typed: "admin",
    handle: "admin",
    status,
    checking: false,
    grantValid: false,
    grantBound: false,
    ...over,
  })
  const offer = (f: TagField, resuming = false, boundGrantOwner = false) =>
    tagSubmit(f, { resuming, boundGrantOwner })
  const routeGrant = { grantToken: "grant-token", grantValid: true }
  const boundGrant = { grantToken: "bound-token", grantBound: true }

  it.each([
    ["a free tag", field("available"), false, false, true],
    ["an unknown answer, which stays out of the way", field("unknown"), false, false, true],
    ["a tag still being checked", field("unknown", { checking: true }), false, false, false],
    ["no tag", field("unknown", { handle: null }), false, false, false],
    ["a reservation", field("reserved"), false, false, false],
    ["a reservation, resumed", field("reserved"), true, false, true],
    ["a blocklisted tag, resumed", field("blocked"), true, false, false],
    ["a blocked reservation, resumed", field("blocked-reserved"), true, false, false],
    ["a blocklisted tag on its route grant", field("blocked", routeGrant), false, false, true],
    ["a reservation on a route grant", field("reserved", routeGrant), false, false, false],
    [
      "a blocked reservation on a route grant",
      field("blocked-reserved", routeGrant),
      false,
      false,
      false,
    ],
    [
      "a blocked reservation on a route grant, resumed",
      field("blocked-reserved", routeGrant),
      true,
      false,
      true,
    ],
    [
      "a grant the service could not check",
      field("unknown", { grantToken: "t" }),
      false,
      false,
      false,
    ],
    [
      "a bound grant's blocked reservation, by its owner",
      field("blocked-reserved", boundGrant),
      true,
      true,
      true,
    ],
  ])("offers %s: %s", (_, f, resuming, owner, submittable) => {
    expect(offer(f, resuming, owner).submittable).toBe(submittable)
  })

  it("holds a step whose payment cannot cover the account yet", () => {
    const rule = { resuming: false, boundGrantOwner: false }
    expect(tagSubmit(field("available"), { ...rule, held: true }).submittable).toBe(false)
  })

  it("sends a bound grant to its passkey, unless the owner is back", () => {
    const bound = field("blocked", boundGrant)
    expect(offer(bound)).toMatchObject({ recoverBoundGrant: true, submittable: true })
    expect(offer(bound, true, true).recoverBoundGrant).toBe(false)
  })

  it("names an unchecked grant so the step can say so", () => {
    expect(offer(field("unknown", { grantToken: "t" })).grantUnverified).toBe(true)
    expect(offer(field("unknown", { grantToken: "t", checking: true })).grantUnverified).toBe(false)
  })
})
