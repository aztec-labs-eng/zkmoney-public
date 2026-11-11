// The sign-in flow on /enter: its arrival, the tag field, the completion writes and the reload guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { service } from "@obsidion/front-core"
import { RESOLVE_DEBOUNCE_MS } from "../../../src/features/onboarding/EnterAppScreen/signInFlow"
import { closeSession } from "../../../src/session/session"
import { savedIdentity } from "../../support/identity"
import { committed, seedDeviceKeys } from "../../support/page"
import {
  ceremonyRequired,
  confirmResult,
  flush,
  FOUND,
  named,
  openSignIn,
  remember,
  resolved,
  typeTag,
} from "../../support/signIn"

let opened: Awaited<ReturnType<typeof openSignIn>>[] = []
const open = async (...args: Parameters<typeof openSignIn>) => {
  const flow = await openSignIn(...args)
  opened.push(flow)
  return flow
}

beforeEach(() => sessionStorage.clear())
afterEach(() => {
  for (const { ended } of opened) ended.abort()
  opened = []
  closeSession()
})

describe("the arrival", () => {
  it("probes the ceremony-free sources first; with none the screen shows, prepared, with no prompt", async () => {
    const { flow, io, lastEntry } = await open()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(lastEntry()).toMatchObject({ cacheOnly: true })
    expect(lastEntry().restoreCache).toBeUndefined()
    expect(flow.state.get()).toMatchObject({ shown: true, prepared: "ready", refusal: undefined })
    // The probe fetched the manifest and made the one cache proof: nothing more to prepare.
    expect(io.warm).not.toHaveBeenCalled()
    expect(io.landing).toHaveBeenCalledWith("login")
  })

  it("a cached key enters with no screen, and the strict reload's tag is never read", async () => {
    const { flow, io, lastEntry, navigate } = await open("handle=bob&strict=1", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    flow.start(new AbortController().signal)
    await flush()
    expect(lastEntry()).toMatchObject({ tag: "bob", strictTag: true, cacheOnly: true })
    expect(io.lookup).not.toHaveBeenCalled()
    expect(flow.state.get().shown).toBe(false)
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("the arrival handle seeds the field and resolves once; Login then pins its keys", async () => {
    const { flow, io, lastEntry, entered } = await open("handle=Alice", { start: false })
    io.lookup.mockResolvedValueOnce(resolved())
    await opened[0]!.start()
    expect(flow.state.get().typed).toBe("alice")
    expect(io.lookup).toHaveBeenCalledTimes(1)
    expect(flow.submitReady()).toBe(true)
    io.enterWithPasskey.mockResolvedValueOnce(named())
    flow.login()
    await flush()
    expect(lastEntry()).toMatchObject({ tag: "alice", hints: FOUND, restoreCache: false })
    expect(io.fire).toHaveBeenCalledWith("passkey_by_tag_lookup_resolved", { more_keys: false })
    expect(entered()).toBe(true)
  })

  it("a read that failed before anything was asked or written shows the screen, which prepares itself", async () => {
    const { flow, io, session, failures, navigate } = await open("", { start: false })
    io.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await opened[0]!.start()
    expect(flow.state.get()).toMatchObject({ shown: true, prepared: "ready" })
    expect(io.warm).toHaveBeenCalledTimes(1)
    expect(session.auth.recoverFromCache).toHaveBeenCalledTimes(1)
    expect(io.report).not.toHaveBeenCalled()
    expect(failures()).toEqual([["enter", "unknown"]])
    expect(navigate).not.toHaveBeenCalled()
  })

  it("a write that failed after the probe committed shows its card: Retry re-probes", async () => {
    const { flow, io, lastEntry } = await open("", { start: false })
    const disk = Object.assign(new Error("disk full"), { committed: true })
    io.enterWithPasskey.mockRejectedValueOnce(disk)
    await opened[0]!.start()
    const { refusal } = flow.state.get()
    expect(refusal).toMatchObject({ name: "error", probeCommitted: true })
    expect(flow.retryable(refusal!)).toBe(true)
    expect(io.report).toHaveBeenCalledTimes(1)
    flow.rerun()
    await flush()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(lastEntry().cacheOnly).toBe(true)
    expect(flow.state.get().shown).toBe(true)
  })

  it("?choose=1 skips the probe and prepares the screen; nothing opens once it is ready", async () => {
    let warm!: (value: object) => void
    const { flow, io, session } = await open("choose=1", { start: false })
    io.warm.mockReturnValueOnce(new Promise<object>((r) => (warm = r)))
    await opened[0]!.start()
    expect(io.enterWithPasskey).not.toHaveBeenCalled()
    expect(flow.state.get()).toMatchObject({ shown: true, prepared: "pending" })
    warm({})
    await flush()
    expect(flow.state.get().prepared).toBe("ready")
    expect(session.auth.recoverFromCache).toHaveBeenCalledTimes(1)
    expect(io.enterWithPasskey).not.toHaveBeenCalled()
  })

  it("waits for a held cache proof, and a failed preparation prepares again", async () => {
    let proved!: (value: undefined) => void
    const { flow, io, session } = await open("choose=1", { start: false })
    vi.mocked(session.auth.recoverFromCache).mockReturnValueOnce(
      new Promise<undefined>((r) => (proved = r)),
    )
    io.warm.mockRejectedValueOnce(new Error("offline"))
    await opened[0]!.start()
    expect(flow.state.get().prepared).toBe("failed")
    flow.prepare()
    await flush()
    expect(flow.state.get().prepared).toBe("pending")
    proved(undefined)
    await flush()
    expect(flow.state.get().prepared).toBe("ready")
    expect(io.enterWithPasskey).not.toHaveBeenCalled()
  })

  it("a cancelled probe whose read ends needing a ceremony shows no screen and reads nothing", async () => {
    let release!: (value: unknown) => void
    const { flow, io, navigate } = await open("handle=alice", { start: false })
    io.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await opened[0]!.start()
    flow.cancel()
    expect(navigate).toHaveBeenCalledWith("/claim", { replace: true })
    release(ceremonyRequired)
    await flush()
    expect(flow.state.get().shown).toBe(false)
    expect(io.lookup).not.toHaveBeenCalled()
  })
})

describe("the flow's lifecycle", () => {
  it("a start aborted at once, as StrictMode replays it, leaves only the replay to probe and enter", async () => {
    const { flow, io, navigate } = await open("", { start: false })
    io.enterWithPasskey.mockResolvedValue(named())
    const first = new AbortController()
    flow.start(first.signal)
    first.abort()
    await opened[0]!.start()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(navigate.mock.calls.filter(([to]) => to === "/")).toHaveLength(1)
  })

  it("the chooser arrival seeds the handle again on the replay, and it resolves", async () => {
    const { flow, io } = await open("choose=1&handle=alice", { start: false })
    io.lookup.mockResolvedValue(resolved())
    const first = new AbortController()
    flow.start(first.signal)
    await flush()
    first.abort()
    await opened[0]!.start()
    expect(flow.state.get().typed).toBe("alice")
    expect(io.lookup).toHaveBeenCalledTimes(2)
    expect(flow.submitReady()).toBe(true)
  })

  it("waits for the wallet: nothing runs before it is ready, and leaving first runs nothing", async () => {
    let ready!: (wallet: object) => void
    const wallet = service(
      "wallet",
      { from: [], retry: "manual" },
      () => new Promise<object>((r) => (ready = r)),
    )
    const { io, ended } = await open("", { wallet })
    expect(io.enterWithPasskey).not.toHaveBeenCalled()
    ready({ networkId: "0xnet" })
    await flush()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(1)

    const late = service(
      "wallet",
      { from: [], retry: "manual" },
      () => new Promise<object>(() => {}),
    )
    const left = await open("", { wallet: late })
    left.ended.abort()
    await flush()
    expect(left.io.enterWithPasskey).not.toHaveBeenCalled()
    expect(left.gate.cancel).toHaveBeenCalled()
    ended.abort()
  })

  it("leaving ends the attempt behind the prompt and its gate", async () => {
    const { flow, io, gate, ended, lastEntry } = await open()
    io.enterWithPasskey.mockReturnValueOnce(new Promise(() => {}))
    flow.showPasskeys()
    ended.abort()
    expect((lastEntry().signal as AbortSignal).aborted).toBe(true)
    expect(gate.cancel).toHaveBeenCalled()
  })
})

describe("the field", () => {
  it("a pause in typing reads the tag; a blur reads at once; an edit unreadies Login", async () => {
    const { flow, io } = await open()
    io.lookup.mockResolvedValue(resolved("bob"))
    flow.tagChanged("@Bob")
    expect(io.lookup).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, RESOLVE_DEBOUNCE_MS + 20))
    expect(io.lookup).toHaveBeenCalledWith("bob", expect.anything())
    expect(flow.submitReady()).toBe(true)
    flow.tagChanged("bobb")
    expect(flow.submitReady()).toBe(false)
    io.lookup.mockResolvedValue(resolved("bobb"))
    flow.tagBlurred()
    await flush()
    expect(io.lookup).toHaveBeenLastCalledWith("bobb", expect.anything())
    expect(io.lookup).toHaveBeenCalledTimes(2)
    expect(flow.submitReady()).toBe(true)
  })

  it("Login runs only once the typed tag resolved, then pins exactly once", async () => {
    const { flow, io, lastEntry } = await open()
    flow.tagChanged("bob")
    flow.login()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(1)
    io.lookup.mockResolvedValueOnce(resolved("bob"))
    flow.tagBlurred()
    await flush()
    io.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    flow.login()
    await flush()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(lastEntry().tag).toBe("bob")
  })

  it("a tag the list shows is not read: its notice names the row, and an edit reads again", async () => {
    await remember({ credentialId: "cred-alice", usertag: "alice" })
    const { flow, io, failures } = await open()
    await typeTag(flow, "@Alice")
    expect(io.lookup).not.toHaveBeenCalled()
    expect(flow.state.get().notice).toEqual({ kind: "listed", tag: "alice" })
    expect(flow.submitReady()).toBe(false)
    expect(failures()).toEqual([])
    flow.tagBlurred()
    expect(io.lookup).not.toHaveBeenCalled()
    io.lookup.mockResolvedValueOnce(resolved("alicia"))
    await typeTag(flow, "alicia")
    expect(flow.state.get().notice).toBeUndefined()
    expect(io.lookup).toHaveBeenCalledWith("alicia", expect.anything())
  })

  it("a listed tag's other passkey reads the tag; Login then pins the account's keys", async () => {
    await remember({ credentialId: "cred-alice", usertag: "alice" })
    const { flow, io, lastEntry, entered } = await open()
    await typeTag(flow, "alice")
    io.lookup.mockResolvedValueOnce(resolved())
    flow.differentPasskey()
    await flush()
    expect(io.lookup).toHaveBeenCalledWith("alice", expect.anything())
    expect(flow.state.get().notice).toBeUndefined()
    io.enterWithPasskey.mockResolvedValueOnce(named())
    flow.login()
    await flush()
    expect(lastEntry().hints).toEqual(FOUND)
    expect(entered()).toBe(true)
  })

  it("an invalid tag runs no read", async () => {
    const { flow, io } = await open()
    await typeTag(flow, "a b")
    expect(io.lookup).not.toHaveBeenCalled()
  })

  it.each([
    ["inconclusive", { kind: "inconclusive" }, "inconclusive", "bytag_inconclusive"],
    ["no account", { kind: "notFound" }, "notFound", "bytag_tag_not_found"],
    ["a stale rollup", { kind: "staleRollup" }, "staleRollup", "bytag_stale_rollup"],
  ])("%s stays inline with its own code; an edit clears it", async (_l, read, kind, code) => {
    const { flow, io, failures } = await open()
    io.lookup.mockResolvedValueOnce(read)
    await typeTag(flow, "alice")
    expect(flow.state.get()).toMatchObject({ notice: { kind, tag: "alice" }, resolving: false })
    expect(flow.state.get().refusal).toBeUndefined()
    expect(failures().at(-1)).toEqual(["enter:by-tag", code])
    flow.tagChanged("bob")
    expect(flow.state.get().notice).toBeUndefined()
  })

  it.each(["reserved", "blocked-reserved"])(
    "a tag with no account whose name is %s reads as reserved",
    async (status) => {
      const { flow, io } = await open()
      io.probeName.mockResolvedValueOnce({ status })
      await typeTag(flow, "alice")
      expect(flow.state.get()).toMatchObject({
        notice: { kind: "reserved", tag: "alice" },
        resolving: false,
      })
    },
  )

  it("a read the network refused says so inline, unreported; leaving the field asks again", async () => {
    const { flow, io, failures } = await open()
    io.lookup.mockRejectedValueOnce(new Error("rpc down"))
    await typeTag(flow, "alice")
    expect(flow.state.get().notice).toEqual({ kind: "lookupFailed", tag: "alice" })
    expect(io.report).not.toHaveBeenCalled()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "bytag_lookup_failed"])
    io.lookup.mockResolvedValueOnce(resolved())
    flow.tagBlurred()
    await flush()
    expect(io.lookup).toHaveBeenCalledTimes(2)
    expect(flow.submitReady()).toBe(true)
  })

  it("only the current read lands; a blur after a resolved tag reads nothing again", async () => {
    const { flow, io } = await open()
    let older!: (value: unknown) => void
    io.lookup.mockReturnValueOnce(new Promise((r) => (older = r)))
    await typeTag(flow, "alice")
    expect(flow.state.get().resolving).toBe(true)
    await typeTag(flow, "alicex")
    expect(flow.state.get().notice).toEqual({ kind: "notFound", tag: "alicex" })
    older(resolved())
    await flush()
    expect(flow.state.get()).toMatchObject({ found: undefined, notice: { kind: "notFound" } })

    io.lookup.mockResolvedValueOnce(resolved())
    await typeTag(flow, "alice")
    flow.tagBlurred()
    expect(io.lookup).toHaveBeenCalledTimes(3)
    expect(flow.submitReady()).toBe(true)
  })

  it("a typed tag, not the URL's, is the one the pinned entry names", async () => {
    const { flow, io, lastEntry } = await open("handle=alice")
    io.lookup.mockResolvedValueOnce(resolved("bob"))
    await typeTag(flow, "bob")
    flow.login()
    await flush()
    expect(lastEntry().tag).toBe("bob")
  })
})

describe("the completion writes", () => {
  it("an entry reported after a cancel writes no identity and navigates nowhere", async () => {
    await seedDeviceKeys({ storageId: "storage-a", credentialId: "cred-alice" })
    const { flow, io, navigate, entered } = await open("handle=alice")
    let release!: (value: unknown) => void
    io.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    flow.showPasskeys()
    flow.cancel()
    expect(navigate).toHaveBeenCalledWith("/claim", { replace: true })
    release(named())
    await flush()
    expect(await savedIdentity()).toBeNull()
    expect(committed().passkeyMap).toBeNull()
    expect(entered()).toBe(false)
  })

  it("an entry whose session was replaced while it was saved installs nothing", async () => {
    await seedDeviceKeys({ storageId: "storage-a" })
    const { flow, io, entered } = await open()
    io.enterWithPasskey.mockResolvedValueOnce(named("alice", () => false))
    flow.showPasskeys()
    await flush()
    expect(await savedIdentity()).toBeNull()
    expect(entered()).toBe(false)
  })
})

describe("the reload guard", () => {
  const switchesTo = (id: string, result: unknown) => async () => {
    await seedDeviceKeys({ storageId: id })
    return result
  }
  beforeEach(() => seedDeviceKeys({ storageId: "storage-a" }))

  it("a pinned entry that switched accounts reloads with the tag and strict=1, keeping next", async () => {
    const { flow, io, navigate } = await open("handle=alice&next=%2Frequest%23gift")
    io.lookup.mockResolvedValueOnce(resolved("bob"))
    await typeTag(flow, "bob")
    io.enterWithPasskey.mockImplementationOnce(switchesTo("storage-b", named("bob")))
    flow.login()
    await flush()
    expect(io.leave).toHaveBeenCalledWith("/enter?handle=bob&strict=1&next=%2Frequest%23gift")
    expect(navigate).not.toHaveBeenCalled()
  })

  it("a ?pick entry that switched accounts reloads without pick", async () => {
    await remember({ credentialId: "cred-alice", usertag: "alice" })
    const { flow, io } = await open("pick=cred-alice")
    io.enterWithPasskey.mockImplementationOnce(switchesTo("storage-b", named()))
    flow.chooseAccount(flow.remembered().candidates[0]!)
    await flush()
    expect(io.leave).toHaveBeenCalledWith("/enter?handle=alice&strict=1")
  })

  it("the strict remount probes under a signal, and a wrong remembered tag confirms", async () => {
    const { flow, io, lastEntry, navigate } = await open("handle=bob&strict=1", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    await opened[0]!.start()
    expect(lastEntry()).toMatchObject({ strictTag: true, cacheOnly: true })
    expect(lastEntry().hints).toBeUndefined()
    expect(io.leave).not.toHaveBeenCalled()
    expect(flow.state.get()).toMatchObject({ confirming: true, selectedTag: "bob" })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("a cancel during the remounted probe aborts it; its uncommitted answer shows nothing", async () => {
    let release!: (value: unknown) => void
    const { flow, io, lastEntry, failures } = await open("handle=bob&strict=1", { start: false })
    io.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await opened[0]!.start()
    flow.cancel()
    expect((lastEntry().signal as AbortSignal).aborted).toBe(true)
    release({ entered: false, reason: "unknown" })
    await flush()
    expect(flow.state.get()).toMatchObject({ refusal: undefined, shown: false })
    expect(failures()).toEqual([])
  })
})
