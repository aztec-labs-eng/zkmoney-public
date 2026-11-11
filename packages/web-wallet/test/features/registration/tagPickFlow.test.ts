// @vitest-environment node
/** The tag pick sheets' flow, over the real availability probe with the account service stubbed. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { composeWireNameHash } from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PageChain } from "../../../src/session/pageChain"
import type { ProbePage } from "../../../src/features/registration/nameAvailability"
import { createSignupStash } from "../../../src/features/registration/signupStash"
import { openTagPickFlow, type TagPickDeps } from "../../../src/features/registration/tagPickFlow"
import { sandboxConfig } from "../../support/seedBootConfig"
import { fakeTabStash } from "../../support/tabStash"
import { answered, testQuery } from "../../support/query"

const ENS = "obsidion.eth"
const DEBOUNCE = 350

/** The service's answer per tag; a tag it does not list fails the read. */
let answers: Record<string, "available" | "reserved" | "blocked">
const reads: string[] = []

let page: ProbePage
beforeAll(async () => {
  const tuple = { ensDomain: ENS, rollupVersion: "1" } as OxideEnvTuple
  const chain = { oxideTuple: answered(tuple) } as unknown as PageChain
  page = { config: await sandboxConfig(), chain, query: testQuery() }
})

beforeEach(() => {
  vi.useFakeTimers()
  answers = {}
  reads.length = 0
  const byHash = () =>
    new Map(Object.keys(answers).map((tag) => [composeWireNameHash(tag, ENS), tag]))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const tag = byHash().get(new URL(url).searchParams.get("nameHash") as `0x${string}`)
      reads.push(tag ?? "?")
      if (!tag) return new Response("down", { status: 503 })
      return new Response(JSON.stringify({ status: answers[tag] }))
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function sheet(over: Partial<TagPickDeps> = {}) {
  const fired: [string, unknown][] = []
  const flow = openTagPickFlow({
    page,
    screen: "deposit",
    fire: (event, props) => void fired.push([event, props]),
    ...over,
  })
  const ended = new AbortController()
  flow.start(ended.signal)
  return { flow, fired, end: () => ended.abort(), view: () => flow.view.get() }
}

const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE)
const checks = (fired: [string, unknown][]) =>
  fired.filter(([e]) => e === "onboarding_handle_checked").map(([, p]) => p)

describe("the tag pick flow", () => {
  it("reports its opening once per start, with its screen", () => {
    const { fired } = sheet({ screen: "settings" })
    expect(fired).toEqual([["name_sheet_opened", { screen: "settings" }]])
  })

  it("keeps what is typed, folded, in the tab's signup draft", () => {
    const stash = fakeTabStash()
    const { flow } = sheet({ signup: createSignupStash(stash) })
    flow.type("@Alice")
    expect(flow.view.get().typed).toBe("alice")
    expect(createSignupStash(stash).state.get().tagDraft).toBe("alice")
  })

  it("keeps what is typed while the tab's draft is cleared under it", () => {
    const signup = createSignupStash(fakeTabStash())
    const { flow } = sheet({ signup })
    flow.type("alice")
    signup.setTagDraft("")
    expect(flow.view.get().typed).toBe("alice")
  })

  it("checks a seeded tag before any probe, then offers it once the service finds it free", async () => {
    answers = { alice: "available" }
    const signup = createSignupStash(fakeTabStash())
    signup.setTagDraft("alice")
    const { view } = sheet({ signup })
    expect(view()).toMatchObject({ name: "alice", checking: true, available: false })
    await settle()
    expect(view()).toMatchObject({ status: "available", checking: false, available: true })
  })

  it("never probes the tag already held or a malformed one", async () => {
    const { flow, view } = sheet({ current: "alice" })
    flow.type("alice")
    await settle()
    expect(view()).toMatchObject({ checking: false, available: false, status: "unknown" })
    flow.type("not a tag!")
    await settle()
    expect(view()).toMatchObject({ name: null, checking: false })
    expect(reads).toEqual([])
  })

  it("probes only the tag typed last, and drops the answer for one typed over", async () => {
    answers = { bo: "reserved", bob: "available" }
    const { flow, view } = sheet()
    flow.type("bo")
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1)
    flow.type("bob")
    expect(view().checking).toBe(true)
    await settle()
    expect(reads).toEqual(["bob"])
    expect(view()).toMatchObject({ name: "bob", available: true })
  })

  it("reads a failed probe as unknown, and reports no verdict for it", async () => {
    const { flow, fired, view } = sheet()
    flow.type("carol")
    await settle()
    expect(view()).toMatchObject({ status: "unknown", checking: false, available: false })
    expect(checks(fired)).toEqual([])
  })

  it("reports one verdict per distinct tag it settles", async () => {
    answers = { dave: "reserved", erin: "blocked" }
    const { flow, fired } = sheet()
    flow.type("dave")
    await settle()
    flow.type("dave")
    flow.type("erin")
    await settle()
    flow.type("dav")
    flow.type("dave")
    await settle()
    expect(checks(fired)).toEqual([{ status: "taken" }, { status: "blocked" }, { status: "taken" }])
  })

  it("runs the pick on the folded tag once it is free, busy until it ends", async () => {
    answers = { frank: "available" }
    const { flow, view } = sheet()
    const picks: { name: string; busy: boolean }[] = []
    const run = vi.fn(async (name: string) => void picks.push({ name, busy: view().busy }))
    await flow.pick(run)
    expect(run).not.toHaveBeenCalled()
    flow.type("Frank")
    await flow.pick(run)
    expect(run).not.toHaveBeenCalled()
    await settle()
    await flow.pick(run)
    expect(picks).toEqual([{ name: "frank", busy: true }])
    expect(view().busy).toBe(false)
  })

  it("keeps a failed pick's error until the next pick, and runs one pick at a time", async () => {
    answers = { gina: "available" }
    const { flow, view } = sheet()
    flow.type("gina")
    await settle()
    const refused = new Error("refused")
    await flow.pick(async () => {
      throw refused
    })
    expect(view()).toMatchObject({ busy: false, error: refused })

    let finish!: () => void
    const first = flow.pick(() => new Promise<void>((done) => (finish = done)))
    expect(view().busy).toBe(true)
    expect(view().error).toBeUndefined()
    const second = vi.fn(async () => {})
    await flow.pick(second)
    expect(second).not.toHaveBeenCalled()
    finish()
    await first
    expect(view().busy).toBe(false)
  })

  it("probes and reports again after a start that was aborted and replayed", async () => {
    answers = { ivy: "available" }
    const { flow, fired, end, view } = sheet()
    end()
    const replay = new AbortController()
    flow.start(replay.signal)
    flow.type("ivy")
    await settle()
    expect(view().available).toBe(true)
    expect(reads).toEqual(["ivy"])
    expect(checks(fired)).toEqual([{ status: "available" }])
  })

  it("stops probing once the sheet ends", async () => {
    answers = { hal: "available" }
    const { flow, end } = sheet()
    flow.type("hal")
    end()
    await settle()
    expect(reads).toEqual([])
  })
})
