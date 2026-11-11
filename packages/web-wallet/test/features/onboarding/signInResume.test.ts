// The sign-in's ways on past a result: reservations, bound grants, the confirm step and the cards.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { namehash } from "viem/ens"
import { PasskeyEnvelopeError } from "@obsidion/front-core"
import { PhoneRequiredError } from "@obsidion/passkey-web"
import { PasskeySetUnreadError } from "../../../src/features/onboarding/oxideOnboarding"
import { closeSession } from "../../../src/session/session"
import { savedIdentity } from "../../support/identity"
import { seedDeviceKeys } from "../../support/page"
import {
  confirmResult,
  flush,
  FOUND,
  named,
  nameless,
  openSignIn,
  OTHER,
  remember,
  resolved,
  typeTag,
  unknownResult,
} from "../../support/signIn"

let ended: AbortController[] = []
const open = async (...args: Parameters<typeof openSignIn>) => {
  const opened = await openSignIn(...args)
  ended.push(opened.ended)
  return opened
}
/** The screen with @alice resolved, ready for Login. */
async function found(search = "handle=alice") {
  const opened = await open(search, { start: false })
  opened.io.lookup.mockResolvedValueOnce(resolved())
  await opened.start()
  return opened
}
const hashes = (...tags: string[]) => tags.map((tag) => namehash(`${tag}.zk.money`))
const boundGrant = () => {
  sessionStorage.setItem("obsidion.name-grant", "bound-token")
  sessionStorage.setItem("obsidion.name-grant-handle", "alice")
}

beforeEach(() => sessionStorage.clear())
afterEach(() => {
  for (const end of ended) end.abort()
  ended = []
  closeSession()
})

describe("a reservation", () => {
  it("the pinned entry's tag names is picked back up at once, never under the URL's", async () => {
    const { flow, io, session, navigate } = await open("handle=alice")
    io.lookup.mockResolvedValueOnce(resolved("bob"))
    await typeTag(flow, "bob")
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    io.reservedNameHashes.mockResolvedValueOnce(hashes("alice", "bob"))
    await seedDeviceKeys({ storageId: "storage-a" })
    flow.login()
    await flush()
    expect(io.claimTag).toHaveBeenCalledTimes(1)
    expect(io.claimTag.mock.calls[0]![1]).toBe("bob")
    expect(await savedIdentity()).toMatchObject({ handle: "bob", pending: true })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(flow.state.get().refusal).toBeUndefined()
  })

  it.each([
    ["the passkey's own name, with nothing typed", "", { userHandle: "carol" }, "carol"],
    [
      "the passkey's own name, where the arrival tag names none",
      "handle=alice",
      { userHandle: "carol" },
      "carol",
    ],
    [
      "the name this browser remembers, before the passkey's",
      "",
      { usertag: "niall", userHandle: "carol" },
      "niall",
    ],
    ["the name a reload carried", "named=carol", {}, "carol"],
  ])("is named by %s", async (_l, search, extra, tag) => {
    const { flow, io, session } = await open(search)
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session, extra))
    io.reservedNameHashes.mockResolvedValueOnce(hashes("carol", "niall"))
    flow.showPasskeys()
    await flush()
    expect(flow.state.get().confirming).toBe(false)
    expect(io.claimTag.mock.calls[0]?.[1]).toBe(tag)
  })

  it("nothing names asks for its tag, which a carried name never fills", async () => {
    const { flow, io, session } = await open("named=carol")
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    io.reservedNameHashes.mockResolvedValueOnce(hashes("dave"))
    flow.showPasskeys()
    await flush()
    expect(io.claimTag).not.toHaveBeenCalled()
    expect(flow.state.get()).toMatchObject({ confirming: true, reserved: { tag: "" } })
  })

  it("found for a session since replaced is neither replayed nor kept", async () => {
    const { flow, io, session, entered } = await open()
    let held = true
    io.enterWithPasskey.mockResolvedValueOnce(
      nameless(session, { userHandle: "carol", held: () => held }),
    )
    io.reservedNameHashes.mockResolvedValueOnce(hashes("carol"))
    io.claimTag.mockImplementationOnce(async () => {
      held = false
      return { kind: "pending", oxideAccount: "0x1" }
    })
    flow.showPasskeys()
    await flush()
    expect(io.claimTag).toHaveBeenCalledTimes(1)
    expect(await savedIdentity()).toBeNull()
    expect(entered()).toBe(false)

    held = false
    io.enterWithPasskey.mockResolvedValueOnce(
      nameless(session, { userHandle: "carol", held: () => held }),
    )
    io.reservedNameHashes.mockResolvedValueOnce(hashes("carol"))
    flow.showPasskeys()
    await flush()
    expect(io.claimTag).toHaveBeenCalledTimes(1)
    expect(flow.state.get().refusal).toBeUndefined()
  })

  it("a recovery that commits another account reloads carrying the passkey's name", async () => {
    await seedDeviceKeys({ storageId: "storage-a" })
    const { flow, io, session } = await open()
    io.enterWithPasskey.mockImplementationOnce(async () => {
      await seedDeviceKeys({ storageId: "storage-b" })
      return nameless(session, { userHandle: "carol" })
    })
    flow.showPasskeys()
    await flush()
    expect(io.leave).toHaveBeenCalledWith("/enter?named=carol")
  })

  it("whose claim cannot be replayed keeps the card whose way on is the signup", async () => {
    const { flow, io, session, navigate } = await open()
    io.lookup.mockResolvedValueOnce(resolved("bob"))
    await typeTag(flow, "bob")
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    io.reservedNameHashes.mockResolvedValueOnce(hashes("bob"))
    io.claimTag.mockRejectedValueOnce(new Error("claim ledger unavailable"))
    flow.login()
    await flush()
    expect(flow.state.get().refusal).toMatchObject({ resumeTag: "bob" })
    flow.resume("bob")
    expect(navigate).toHaveBeenCalledWith("/claim/bob?resume=1", { replace: true })
  })
})

describe("a bound grant", () => {
  it("returns its own passkey to the unfinished claim", async () => {
    boundGrant()
    const { flow, io, session, navigate, lastEntry } = await found("handle=alice&bound=1")
    io.boundNameGrantOwner.mockResolvedValueOnce(true)
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    flow.login()
    await flush()
    expect(lastEntry()).toMatchObject({ grantToken: "bound-token" })
    expect(navigate).toHaveBeenCalledWith("/claim/alice?resume=1", {
      replace: true,
      state: { boundGrantOwner: "alice" },
    })
    expect(io.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("keeps a different passkey out of its signup", async () => {
    boundGrant()
    const { flow, io, session, navigate } = await found("handle=alice&bound=1")
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    flow.login()
    await flush()
    expect(flow.state.get().refusal?.name).toBe("DifferentPasskeyError")
    expect(navigate).not.toHaveBeenCalled()
    expect(io.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("retries an owner-check outage without another passkey prompt", async () => {
    boundGrant()
    const { flow, io, session, navigate } = await found("handle=alice&bound=1")
    io.enterWithPasskey.mockResolvedValueOnce(nameless(session))
    io.boundNameGrantOwner.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true)
    flow.login()
    await flush()
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("error")
    expect(flow.retryable(refusal!)).toBe(true)
    expect(io.report).not.toHaveBeenCalled()
    const attempts = io.enterWithPasskey.mock.calls.length
    flow.rerun()
    await flush()
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(attempts)
    expect(io.boundNameGrantOwner).toHaveBeenCalledTimes(2)
    expect(navigate).toHaveBeenCalledWith("/claim/alice?resume=1", {
      replace: true,
      state: { boundGrantOwner: "alice" },
    })
  })
})

describe("the confirm step", () => {
  it("opens on the selected tag, and its tag enters the wallet", async () => {
    const { flow, io, entered } = await found()
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    flow.login()
    await flush()
    expect(flow.state.get()).toMatchObject({ confirming: true, selectedTag: "alice" })
    io.confirmTag.mockReturnValueOnce({ handle: "alice", address: "0x1" })
    flow.confirm("alice")
    await flush()
    expect(entered()).toBe(true)
  })

  it("closing it ends the pinned attempt through the shared cancel", async () => {
    const { flow, io, lastEntry, navigate } = await found()
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    flow.login()
    await flush()
    flow.cancel()
    expect((lastEntry().signal as AbortSignal).aborted).toBe(true)
    expect(navigate).toHaveBeenCalledWith("/claim", { replace: true })
  })

  it("Back returns to the screen; a row then enters with no chooser flag", async () => {
    await remember({ credentialId: "cred-alice", usertag: "alice" })
    const { flow, io, lastEntry } = await open()
    io.enterWithPasskey.mockResolvedValueOnce(confirmResult())
    flow.chooseAccount(flow.remembered().candidates[0]!)
    await flush()
    flow.back()
    expect(flow.state.get()).toMatchObject({ confirming: false, shown: true })
    flow.chooseAccount(flow.remembered().candidates[0]!)
    await flush()
    expect(lastEntry().chooser).toBeUndefined()
    expect(lastEntry().hints).toEqual({ credentialId: "cred-alice" })
  })
})

describe("the cards' ways on", () => {
  it.each([
    ["an unconfirmed record", unknownResult({ addresses: [FOUND.l2Address] })],
    ["a policy refusal", new PhoneRequiredError()],
    ["a backup envelope that did not open", new PasskeyEnvelopeError("unverified")],
  ])("%s keeps a retry that pins again with no second read", async (_l, outcome) => {
    const { flow, io, lastEntry, entered } = await found()
    if (outcome instanceof Error) io.enterWithPasskey.mockRejectedValueOnce(outcome)
    else io.enterWithPasskey.mockResolvedValueOnce(outcome)
    flow.login()
    await flush()
    expect(flow.retryable(flow.state.get().refusal!)).toBe(true)
    io.enterWithPasskey.mockResolvedValueOnce(named())
    flow.rerun()
    await flush()
    expect(io.lookup).toHaveBeenCalledTimes(1)
    expect(lastEntry().hints).toEqual(FOUND)
    expect(entered()).toBe(true)
  })

  it("a committed pinned failure re-probes the committed key", async () => {
    const { flow, io, lastEntry, entered } = await found()
    io.enterWithPasskey.mockRejectedValueOnce(Object.assign(new Error("disk"), { committed: true }))
    flow.login()
    await flush()
    expect(flow.state.get().refusal).toMatchObject({ name: "error", probeCommitted: true })
    io.enterWithPasskey.mockResolvedValueOnce(named())
    flow.rerun()
    await flush()
    expect(lastEntry().cacheOnly).toBe(true)
    expect(entered()).toBe(true)
  })

  it("a prompt that closed names the device with no retry; Back returns to a blank screen", async () => {
    const { flow, io, gate, failures, navigate } = await found()
    let attempt: AbortSignal | undefined
    io.enterWithPasskey.mockImplementationOnce(async (...args: unknown[]) => {
      attempt = (await (args[3] as { gate: () => Promise<{ signal: AbortSignal }> }).gate()).signal
      throw new DOMException("closed", "NotAllowedError")
    })
    flow.login()
    await flush()
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("PasskeyNotOnDeviceError")
    expect(flow.retryable(refusal!)).toBe(false)
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_not_on_device"])
    expect(io.report).not.toHaveBeenCalled()
    flow.back()
    expect(gate.cancel).toHaveBeenCalled()
    expect(attempt).toBeDefined()
    expect(flow.state.get()).toMatchObject({ refusal: undefined, shown: true, typed: "" })
    // No reseed and no read: the arrival handle was taken on the first showing.
    expect(io.lookup).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("on a Mac, this computer's wrong key leads with the phone, which pins the same passkey", async () => {
    const MAC =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/155.0.0.0 Safari/537.36"
    const agent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
    Object.defineProperty(navigator, "userAgent", { value: MAC, configurable: true })
    try {
      const { flow, io, lastEntry } = await found()
      io.enterWithPasskey.mockResolvedValueOnce(
        unknownResult({
          addresses: [OTHER, `0x${"ce".repeat(32)}`],
          observed: { credentialId: "cred-alice", attachment: "platform" },
        }),
      )
      flow.login()
      await flush()
      expect(flow.state.get().refusal).toMatchObject({ macPhone: true })
      flow.usePhone()
      await flush()
      expect(lastEntry()).toMatchObject({ hints: FOUND, phone: true })
    } finally {
      Object.defineProperty(navigator, "userAgent", agent)
    }
  })

  it("a certain wrong key's Show passkeys runs the chooser", async () => {
    const { flow, io, lastEntry } = await found()
    io.enterWithPasskey.mockResolvedValueOnce(
      unknownResult({ storedAddressMismatch: true, verdict: "wrong-key" }),
    )
    flow.login()
    await flush()
    expect(flow.state.get().refusal).toMatchObject({ verdict: "wrong-key" })
    flow.showPasskeys()
    await flush()
    expect(lastEntry()).toMatchObject({ chooser: true, restoreCache: false })
  })

  it("a passkey set the sign-in could not read sends the user to the tag field", async () => {
    const { flow, io } = await open()
    io.enterWithPasskey.mockRejectedValueOnce(new PasskeySetUnreadError())
    flow.showPasskeys()
    await flush()
    const { refusal } = flow.state.get()
    expect(refusal?.name).toBe("PasskeySetUnreadError")
    expect(flow.retryable(refusal!)).toBe(false)
    flow.back()
    expect(flow.state.get()).toMatchObject({ refusal: undefined, shown: true })
    expect(io.enterWithPasskey).toHaveBeenCalledTimes(2)
  })
})
