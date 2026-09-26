import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  entries: [] as { tag?: string; address: string }[],
  typeAhead: vi.fn(),
  commit: vi.fn(),
  addContact: vi.fn(),
  ownHandle: "me" as string | undefined,
}))

vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ getEntries: async () => m.entries }) },
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => (m.ownHandle ? { handle: m.ownHandle } : null),
}))
vi.mock("../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: m.typeAhead,
  resolveTagForCommit: m.commit,
}))
vi.mock("../src/features/contacts/useInlineContactSearch", () => ({ addContact: m.addContact }))

const { TagValidationError } = await import("@obsidion/front-core")
const { lookUpUnsavedContact, saveUnsavedContact, unsavedContact } = await import(
  "../src/features/contacts/unsavedContact"
)

const ADDRESS = `0x${"2c".repeat(32)}`
const resolved = (l2Address = ADDRESS) => ({ status: "resolved", l2Address })

beforeEach(() => {
  vi.clearAllMocks()
  m.entries = []
  m.ownHandle = "me"
  m.addContact.mockResolvedValue({ success: true })
})

describe("lookUpUnsavedContact", () => {
  it("opens a registered tag as an unsaved L2 contact", async () => {
    m.typeAhead.mockResolvedValue(resolved())
    expect(await lookUpUnsavedContact("Grace")).toEqual(unsavedContact("grace", ADDRESS))
    expect(m.typeAhead).toHaveBeenCalledWith("grace")
  })

  it("finds nothing for an unregistered tag, an invalid tag, or the user's own tag", async () => {
    m.typeAhead.mockResolvedValue({ status: "notFound" })
    expect(await lookUpUnsavedContact("nobody")).toBeNull()

    m.typeAhead.mockRejectedValue(new TagValidationError("bad tag"))
    expect(await lookUpUnsavedContact("bad-tag")).toBeNull()

    m.typeAhead.mockClear()
    expect(await lookUpUnsavedContact("me")).toBeNull()
    expect(m.typeAhead).not.toHaveBeenCalled()
  })

  it("lets a network failure through so the page can say so", async () => {
    m.typeAhead.mockRejectedValue(new Error("rpc down"))
    await expect(lookUpUnsavedContact("grace")).rejects.toThrow("rpc down")
  })
})

describe("saveUnsavedContact", () => {
  it("saves the address the page showed once a fresh read confirms it", async () => {
    m.commit.mockResolvedValue(resolved())
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("added")
    expect(m.commit).toHaveBeenCalledWith("grace")
    expect(m.addContact).toHaveBeenCalledWith("grace", ADDRESS, undefined, undefined, "grace")
  })

  it("refuses when the registry moved on since the page resolved it", async () => {
    m.commit.mockResolvedValue(resolved(`0x${"3d".repeat(32)}`))
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("changed")
    m.commit.mockResolvedValue({ status: "notFound" })
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("changed")
    expect(m.addContact).not.toHaveBeenCalled()
  })

  it("does not duplicate a tag saved elsewhere meanwhile", async () => {
    m.commit.mockResolvedValue(resolved())
    m.entries = [{ tag: "grace", address: ADDRESS }]
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("added")
    expect(m.addContact).not.toHaveBeenCalled()
  })

  it("throws when storage refuses the write", async () => {
    m.commit.mockResolvedValue(resolved())
    m.addContact.mockResolvedValue({ success: false, errors: "quota" })
    await expect(saveUnsavedContact(unsavedContact("grace", ADDRESS))).rejects.toThrow("quota")
  })
})
