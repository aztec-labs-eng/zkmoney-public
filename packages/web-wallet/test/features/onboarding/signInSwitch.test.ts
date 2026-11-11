// @vitest-environment node
/**
 * Recovery can commit an account other than the one this page holds, which moves the storage
 * pointer under record stores already loaded: the document is replaced before anything reads them.
 * The page serves PAGE throughout, as the session module keeps the first account a page served.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { namehash } from "viem/ens"
import type { Session } from "../../../src/session/session"
import { closeSession } from "../../../src/session/session"
import { savedIdentity } from "../../support/identity"
import { seedDeviceKeys } from "../../support/page"
import { confirmResult, flush, named, nameless } from "../../support/signIn"
import { deferred, signInSuite } from "../../support/signInFlow"

const open = signInSuite()
const PAGE = "storage-a"
const ANOTHER = "storage-b"

beforeEach(() => seedDeviceKeys({ storageId: PAGE }))

/** The auth service reports the loaded records stale. */
const stale = (session: Session) =>
  Object.assign(session.auth as object, { recordsStale: () => true })

/** The flow at `/enter?<search>`, whose arrival probe commits `id` and answers `result`. */
async function commits(
  id: string,
  result: (session: Session) => unknown,
  {
    search = "",
    next,
    recordsStale = false,
  }: { search?: string; next?: string; recordsStale?: boolean } = {},
) {
  const opened = await open(search, { start: false, next })
  const { io, session } = opened
  io.enterWithPasskey.mockImplementationOnce(async () => {
    await seedDeviceKeys({ storageId: id })
    if (recordsStale) stale(session)
    return result(session)
  })
  await opened.start()
  return opened
}

describe("a sign-in that commits", () => {
  it("the account the page holds continues in place", async () => {
    const { io, navigate } = await commits(PAGE, () => named())
    expect(io.leave).not.toHaveBeenCalled()
    expect(await savedIdentity()).toMatchObject({ handle: "alice" })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("another account replaces the document before the reservation lookup", async () => {
    const { flow, io, navigate } = await commits(ANOTHER, nameless)
    expect(io.leave).toHaveBeenCalledWith("/enter")
    expect(io.reservedNameHashes).not.toHaveBeenCalled()
    expect(flow.state.get().refusal).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it.each([
    ["a cancel", Object.assign(new Error("cancelled"), { name: "GateCancelledError" })],
    ["a failure", new Error("rpc down")],
  ])(
    "%s that lands after another account was committed still replaces the document",
    async (_l, error) => {
      const { flow, io, navigate, start } = await open("", { start: false })
      io.enterWithPasskey.mockImplementationOnce(async () => {
        await seedDeviceKeys({ storageId: ANOTHER })
        throw error
      })
      await start()
      expect(io.leave).toHaveBeenCalledWith("/enter")
      expect(flow.state.get().refusal).toBeUndefined()
      expect(navigate).not.toHaveBeenCalled()
      expect(io.report).not.toHaveBeenCalled()
    },
  )

  it("the reload carries the tag and the onward destination, and drops the chooser flags", async () => {
    const search = "handle=alice&choose=1&avoid=cred-x"
    const { flow, io, session } = await open(search, { next: "/request#gift" })
    io.enterWithPasskey.mockImplementationOnce(async () => {
      await seedDeviceKeys({ storageId: ANOTHER })
      return nameless(session)
    })
    flow.showPasskeys()
    await flush()
    expect(io.leave).toHaveBeenCalledWith("/enter?handle=alice&next=%2Frequest%23gift")
  })

  it.each([
    "https://evil.test/steal",
    "//evil.test/steal",
    "/\\evil.test/steal",
    "/\n/evil.test/steal",
    "/\r/evil.test/steal",
    "/\t/evil.test/steal",
    "/a/..//evil.test/steal",
    "/%2e//evil.test/steal",
  ])("the reload drops an onward destination that leaves this wallet (%j)", async (next) => {
    const { io } = await commits(ANOTHER, nameless, { next })
    expect(io.leave).toHaveBeenCalledWith("/enter")
  })

  it("a document under the account it commits finishes at the URL's destination", async () => {
    const { io, navigate } = await commits(PAGE, () => named(), {
      search: "next=%2Frequest%23gift",
    })
    expect(io.leave).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith("/request#gift", { replace: true })
  })

  it("a URL destination that leaves this wallet is not followed", async () => {
    const search = "next=https%3A%2F%2Fevil.test%2Fsteal"
    const { navigate } = await commits(PAGE, () => named(), { search })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a nameless account reloads on the carried tag, where its reservation then resumes", async () => {
    const first = await commits(ANOTHER, nameless, { search: "handle=cris" })
    expect(first.io.leave).toHaveBeenCalledWith("/enter?handle=cris")
    expect(first.io.reservedNameHashes).not.toHaveBeenCalled()

    // The reloaded document, opened under the account the first one committed.
    first.ended.abort()
    closeSession()
    await seedDeviceKeys({ storageId: PAGE })
    const reloaded = await open("handle=cris", { start: false })
    reloaded.io.enterWithPasskey.mockResolvedValueOnce(nameless(reloaded.session))
    reloaded.io.reservedNameHashes.mockResolvedValueOnce([namehash("cris.zk.money")])
    reloaded.io.claimTag.mockRejectedValueOnce(new Error("claim ledger unavailable"))
    await reloaded.start()
    expect(reloaded.io.leave).not.toHaveBeenCalled()
    expect(reloaded.io.claimTag.mock.calls[0]![1]).toBe("cris")
    reloaded.flow.resume("cris")
    expect(reloaded.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })

  it("an earlier commit on this page that left the records stale replaces the document", async () => {
    const { io } = await commits(PAGE, () => named(), { recordsStale: true })
    expect(io.leave).toHaveBeenCalledWith("/enter?named=alice")
    expect(await savedIdentity()).toBeNull()
  })
})

describe("signed out, as after a logout", () => {
  beforeEach(() => seedDeviceKeys({ storageId: null }))

  it("stale records replace the document before the reservation lookup", async () => {
    const { flow, io, navigate } = await commits(ANOTHER, nameless, { recordsStale: true })
    expect(io.leave).toHaveBeenCalledWith("/enter")
    expect(io.reservedNameHashes).not.toHaveBeenCalled()
    expect(flow.state.get().refusal).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("stale records replace the document before a named account reaches the wallet", async () => {
    const { io, navigate } = await commits(ANOTHER, () => named(), { recordsStale: true })
    expect(io.leave).toHaveBeenCalledWith("/enter?named=alice")
    expect(await savedIdentity(ANOTHER)).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("stale records replace the document before it asks which tag to confirm", async () => {
    const { flow, io } = await commits(ANOTHER, confirmResult, { recordsStale: true })
    expect(io.leave).toHaveBeenCalledWith("/enter")
    expect(flow.state.get().confirming).toBe(false)
  })

  it("a result that lands after the user cancelled still replaces the document", async () => {
    const { flow, io, session, start } = await open("", { start: false })
    const land = deferred<void>()
    io.enterWithPasskey.mockImplementationOnce(async () => {
      await land.promise
      await seedDeviceKeys({ storageId: ANOTHER })
      stale(session)
      return named()
    })
    await start()
    flow.cancel()
    land.resolve()
    await flush()
    expect(io.leave).toHaveBeenCalledWith("/enter?named=alice")
    expect(await savedIdentity(ANOTHER)).toBeNull()
  })

  it("fresh records continue in place: the account enters the wallet", async () => {
    const { io, navigate } = await commits(PAGE, () => named())
    expect(io.leave).not.toHaveBeenCalled()
    expect(await savedIdentity(PAGE)).toMatchObject({ handle: "alice" })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("fresh records send a nameless key to finish signing up, in place", async () => {
    const { flow, io } = await commits(PAGE, nameless)
    expect(io.leave).not.toHaveBeenCalled()
    expect(flow.state.get().refusal?.name).toBe("GrantedRegistrationError")
  })
})
