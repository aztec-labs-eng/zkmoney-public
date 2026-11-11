// @vitest-environment node
// A nameless account account-service holds a claim for: its signup continues as the claim's tag.
import { beforeEach, describe, expect, it } from "vitest"
import { namehash } from "viem/ens"
import { AccountServiceTimeoutError } from "@obsidion/front-core"
import { savedIdentity } from "../../support/identity"
import { seedDeviceKeys } from "../../support/page"
import { confirmResult, flush, L2, nameless } from "../../support/signIn"
import { deferred, signInSuite } from "../../support/signInFlow"

const open = signInSuite()
const hashes = (...tags: string[]) => tags.map((tag) => namehash(`${tag}.zk.money`))
const BOOTSTRAP = "0xE0A0000000000000000000000000000000000001"

beforeEach(() => seedDeviceKeys({ storageId: "storage-a" }))

/** The arrival probe recovers a nameless account whose claims hash to `held`. */
async function arrive(
  search = "",
  held: Promise<string[]> | string[] = hashes("cris"),
  accountServiceTestMode = false,
) {
  const opened = await open(search, { start: false, accountServiceTestMode })
  const { io, session } = opened
  io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
  if (held instanceof Promise) io.reservedNameHashes.mockReturnValueOnce(held)
  else io.reservedNameHashes.mockResolvedValueOnce(held)
  // The claim cannot be replayed here, so a matched tag ends on the card that resumes its signup.
  io.claimTag.mockRejectedValue(new Error("claim ledger unavailable"))
  await opened.start()
  return opened
}

describe("the reservation step", () => {
  it("a typed tag that matches resumes that claim; its card picks the signup back up", async () => {
    const { flow, io, navigate } = await arrive()
    expect(io.reservedNameHashes).toHaveBeenCalledWith(
      expect.objectContaining({ address: BOOTSTRAP }),
      expect.anything(),
    )
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: { tag: "" } })
    flow.confirm("cris")
    await flush()
    expect(io.claimTag.mock.calls[0]![1]).toBe("cris")
    expect(flow.state.get().refusal).toMatchObject({
      name: "ReservedRegistrationError",
      resumeTag: "cris",
    })
    expect(navigate).not.toHaveBeenCalled()
    flow.resume("cris")
    expect(navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
    expect(await savedIdentity()).toBeNull()
  })

  it("a tag that names none of the claims is refused on the step; a decorated form still matches", async () => {
    const { flow, io, navigate } = await arrive()
    flow.confirm("bob")
    expect(flow.state.get().confirmError).toEqual({ kind: "notReserved", tag: "bob" })
    expect(io.claimTag).not.toHaveBeenCalled()
    flow.confirm("cris.zk.money")
    await flush()
    expect(io.claimTag.mock.calls[0]![1]).toBe("cris")
    expect(navigate).not.toHaveBeenCalled()
  })

  it("the link's tag that names the claim skips the step, not the card", async () => {
    const { flow, io } = await arrive("handle=cris")
    expect(flow.state.get().confirming).toBe(false)
    expect(io.claimTag.mock.calls[0]![1]).toBe("cris")
    expect(flow.state.get().refusal?.resumeTag).toBe("cris")
  })

  it("the link's tag that names no claim is only the step's seed", async () => {
    const { flow, io, navigate } = await arrive("handle=alice")
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: { tag: "alice" } })
    expect(io.claimTag).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("account-service test mode never confirms: a lookup it cannot answer leaves the signup card", async () => {
    const { flow, io } = await arrive("", Promise.reject(new Error("unreachable")), true)
    expect(io.reservedNameHashes).toHaveBeenCalledTimes(1)
    expect(flow.state.get().refusal?.name).toBe("GrantedRegistrationError")
  })
})

describe("between attempts", () => {
  it("the reserved card's Back forgets the reservation: the next confirm step is the claim's", async () => {
    const { flow, io, navigate } = await arrive()
    flow.confirm("cris")
    await flush()
    expect(flow.state.get().refusal?.name).toBe("ReservedRegistrationError")
    flow.back()
    expect(flow.state.get()).toMatchObject({ refusal: undefined, shown: true, reserved: undefined })
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    flow.showPasskeys()
    await flush()
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: undefined })
    io.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    flow.confirm("alice")
    await flush()
    expect(io.confirmTag).toHaveBeenCalledTimes(1)
    expect(io.claimTag).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("from a reservation to a registered passkey: the registered tag enters the wallet", async () => {
    const { flow, io, navigate } = await arrive()
    flow.confirm("bob")
    expect(flow.state.get().confirmError).toBeDefined()
    flow.back()
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    flow.showPasskeys()
    await flush()
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: undefined })
    expect(flow.state.get().confirmError).toBeUndefined()
    io.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    flow.confirm("alice")
    await flush()
    expect(io.confirmTag).toHaveBeenCalledTimes(1)
    expect(await savedIdentity()).toMatchObject({ handle: "alice", address: L2 })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(navigate).not.toHaveBeenCalledWith("/claim", expect.anything())
  })

  it("from a registered passkey to a reservation: the reserved tag resumes, saving no identity", async () => {
    const { flow, io, session, navigate, start } = await open("", { start: false })
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    await start()
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: undefined })
    flow.back()
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    io.reservedNameHashes.mockResolvedValueOnce(hashes("cris"))
    io.claimTag.mockRejectedValueOnce(new Error("claim ledger unavailable"))
    flow.showPasskeys()
    await flush()
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: { tag: "" } })
    flow.confirm("cris")
    await flush()
    expect(io.confirmTag).not.toHaveBeenCalled()
    expect(io.claimTag.mock.calls[0]![1]).toBe("cris")
    flow.resume("cris")
    expect(navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
    expect(await savedIdentity()).toBeNull()
  })
})

describe("the retry", () => {
  it("a lookup that fails after the commit is the committed card; retry asks again, not the passkey", async () => {
    const { flow, io, session, navigate, failures } = await open("choose=1")
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    io.reservedNameHashes.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    flow.showPasskeys()
    await flush()
    const { refusal } = flow.state.get()
    expect(refusal).toMatchObject({ name: "error", committed: true })
    expect(flow.retryable(refusal!)).toBe(true)
    expect(failures()).not.toContainEqual(["enter", "passkey_prompt_closed"])
    expect(navigate).not.toHaveBeenCalled()
    io.reservedNameHashes.mockResolvedValueOnce(hashes("cris"))
    flow.rerun()
    await flush()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(io.reservedNameHashes).toHaveBeenCalledTimes(2)
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: { tag: "" } })
  })

  it("the committed card's way on continues the signup rather than starting one", async () => {
    const { flow, navigate } = await arrive("", Promise.reject(new Error("offline")))
    expect(flow.state.get().refusal?.committed).toBe(true)
    flow.continueSignup()
    expect(navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a sign-in failure before any commit retries the sign-in, not the lookup", async () => {
    const { flow, io } = await open("choose=1")
    io.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    flow.showPasskeys()
    await flush()
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("error")
    expect(refusal?.committed).toBeUndefined()
    io.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    flow.rerun()
    await flush()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(io.reservedNameHashes).not.toHaveBeenCalled()
  })
})

describe("a late answer", () => {
  it("to the lookup, after Cancel sign-in, does nothing", async () => {
    const lookup = deferred<string[]>()
    const { flow, navigate } = await arrive("", lookup.promise)
    flow.cancel()
    expect(navigate).toHaveBeenCalledWith("/claim", { replace: true })
    navigate.mockClear()
    lookup.resolve(hashes("cris"))
    await flush()
    expect(navigate).not.toHaveBeenCalled()
    expect(flow.state.get()).toMatchObject({ confirming: false, refusal: undefined })
  })

  it("of a failed lookup, after Cancel sign-in, reports nothing", async () => {
    const lookup = deferred<string[]>()
    const { flow, io } = await arrive("", lookup.promise)
    flow.cancel()
    lookup.reject(new Error("offline"))
    await flush()
    expect(io.report).not.toHaveBeenCalled()
    expect(flow.state.get().refusal).toBeUndefined()
  })

  it("to the retry's lookup, after Cancel sign-in, leaves nothing behind", async () => {
    const { flow, io, navigate } = await arrive("", Promise.reject(new Error("offline")))
    const lookup = deferred<string[]>()
    io.reservedNameHashes.mockReturnValueOnce(lookup.promise)
    flow.rerun()
    await flush()
    flow.cancel()
    navigate.mockClear()
    lookup.resolve(hashes("cris"))
    await flush()
    expect(navigate).not.toHaveBeenCalled()
    expect(flow.state.get().confirming).toBe(false)
  })
})
