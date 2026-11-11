import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { testPage, testCore } from "../../support/page"
import type { OnNetwork, Transaction } from "@obsidion/front-core"
import type { Session } from "../../../src/session/session"

const m = vi.hoisted(() => ({
  typeAhead: vi.fn(),
  commit: vi.fn(),
}))

vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: m.typeAhead,
  resolveTagForCommit: m.commit,
}))

const { TagValidationError, createContacts, memoryBackend, openDatabase } = await import(
  "@obsidion/front-core"
)
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../src/session/session"
)
const { pageSessionDeps } = await import("../../../src/app/sessionDeps")
const { lookUpUnsavedContact, pastAddressOf, saveUnsavedContact, unsavedContact } = await import(
  "../../../src/features/contacts/unsavedContact"
)

const ADDRESS = `0x${"2c".repeat(32)}`
const OWN = "me"
const resolved = (l2Address = ADDRESS) => ({ status: "resolved", l2Address })

let session: Session
beforeEach(() => {
  vi.clearAllMocks()
  session = switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
})
afterEach(closeSession)

describe("lookUpUnsavedContact", () => {
  it("opens a registered tag as an unsaved L2 contact", async () => {
    m.typeAhead.mockResolvedValue(resolved())
    expect(await lookUpUnsavedContact(session, "Grace", OWN)).toEqual(
      unsavedContact("grace", ADDRESS),
    )
  })

  it("finds nothing for an unregistered tag, an invalid tag, or the user's own tag", async () => {
    m.typeAhead.mockResolvedValue({ status: "notFound" })
    expect(await lookUpUnsavedContact(session, "nobody", OWN)).toBeNull()

    m.typeAhead.mockRejectedValue(new TagValidationError("bad tag"))
    expect(await lookUpUnsavedContact(session, "bad-tag", OWN)).toBeNull()

    m.typeAhead.mockClear()
    expect(await lookUpUnsavedContact(session, "me", OWN)).toBeNull()
    expect(m.typeAhead).not.toHaveBeenCalled()
  })

  it("opens a tag still on an older zk.money at the address its past transfers used", async () => {
    m.typeAhead.mockResolvedValue({ status: "staleRollup" })
    expect(await lookUpUnsavedContact(session, "grace", OWN)).toEqual(unsavedContact("grace", ""))

    const txHash = `0x${"5a".repeat(32)}`
    const sent = { action: "send", token: { amount: 5 }, toTag: "Grace", to: ADDRESS }
    await session.transfers.record({
      ...sent,
      id: txHash,
      txHash,
      status: "success",
      timestamp: 1,
      networkId: "0xnet",
    } as OnNetwork<Transaction>)
    expect(await lookUpUnsavedContact(session, "grace", OWN)).toEqual(
      unsavedContact("grace", ADDRESS),
    )
  })

  it("opens a tag still on an older zk.money at the address this device's send used", async () => {
    m.typeAhead.mockResolvedValue({ status: "staleRollup" })
    const { operations } = session
    await operations.begin({ operationId: "op-grace", flow: "send", summary: "" })
    const token = {
      address: "0xt",
      name: "DAI",
      symbol: "DAI",
      decimals: 6,
      amount: 5,
      logo: "",
      price: 1,
    }
    const payload = { networkId: "0xnet", token, amountAtomic: "5", to: ADDRESS, toTag: "Grace" }
    await operations.apply("op-grace", { type: "transfer", transfer: { kind: "send", payload } })
    expect(await lookUpUnsavedContact(session, "grace", OWN)).toEqual(
      unsavedContact("grace", ADDRESS),
    )
  })

  it("lets a network failure through so the page can say so", async () => {
    const down = new Error("rpc down")
    m.typeAhead.mockRejectedValue(down)
    await expect(lookUpUnsavedContact(session, "grace", OWN)).rejects.toBe(down)
  })
})

describe("pastAddressOf", () => {
  const OTHER = `0x${"4e".repeat(32)}`
  const token = { amount: 5 }

  it("reads a send's recipient and a receive's sender for the tag", () => {
    const send = { action: "send", token, toTag: "grace", to: ADDRESS }
    const receive = { action: "receive", token, from: "grace", senderL2Address: ADDRESS }
    expect(pastAddressOf("grace", [send] as never)).toBe(ADDRESS)
    expect(pastAddressOf("grace", [receive] as never)).toBe(ADDRESS)
  })

  it("ignores other people and rows that are not token transfers", () => {
    const transactions = [
      { action: "send", token, toTag: "bob", to: OTHER },
      { action: "receive", token, from: "bob", senderL2Address: OTHER },
      { action: "send", toTag: "grace", to: OTHER },
    ]
    expect(pastAddressOf("grace", transactions as never)).toBeUndefined()
  })
})

describe("saveUnsavedContact", () => {
  const backend = memoryBackend()
  const contacts = createContacts({ db: openDatabase(backend), now: () => Date.now() })
  const book = async () => (await contacts.all()).map((c) => [c.tag, c.address, c.autoAdded])
  const grace = unsavedContact("grace", ADDRESS)

  beforeEach(async () => {
    await contacts.ready
    backend.failing.commits = false
    for (const { address } of await contacts.all()) await contacts.removeEntry({ address })
  })

  it("saves the address the page showed once a fresh read confirms it", async () => {
    m.commit.mockResolvedValue(resolved())
    expect(await saveUnsavedContact(session, contacts, grace)).toBe("added")
    expect(await book()).toEqual([["grace", ADDRESS, undefined]])
  })

  it("refuses when the registry moved on since the page resolved it", async () => {
    m.commit.mockResolvedValue(resolved(`0x${"3d".repeat(32)}`))
    expect(await saveUnsavedContact(session, contacts, grace)).toBe("changed")
    m.commit.mockResolvedValue({ status: "notFound" })
    expect(await saveUnsavedContact(session, contacts, grace)).toBe("changed")
    expect(await book()).toEqual([])
  })

  it("does not duplicate a tag saved elsewhere meanwhile", async () => {
    m.commit.mockResolvedValue(resolved())
    await contacts.addEntry({ ...grace, name: "Grace" })
    expect(await saveUnsavedContact(session, contacts, grace)).toBe("added")
    expect(await book()).toEqual([["grace", ADDRESS, undefined]])
  })

  it("approves the row the wallet added for the tag", async () => {
    m.commit.mockResolvedValue(resolved())
    await contacts.addEntry({ ...grace, autoAdded: true })
    expect(await saveUnsavedContact(session, contacts, grace)).toBe("added")
    expect(await book()).toEqual([["grace", ADDRESS, undefined]])
  })

  it("throws when storage refuses the write", async () => {
    m.commit.mockResolvedValue(resolved())
    backend.failing.commits = true
    await expect(saveUnsavedContact(session, contacts, grace)).rejects.toThrow()
  })
})
