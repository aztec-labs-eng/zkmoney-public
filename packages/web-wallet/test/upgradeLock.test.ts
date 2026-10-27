import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { portal: "0x" + "AA".repeat(20) } }),
}))

const { walletStorage } = await import("../src/platform/storage/walletStorage")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
const {
  acquireUpgradeLock,
  checkUpgradeLock,
  markCreatedHere,
  markNewAccountHere,
  recordRetiredSourceRead,
  releaseUpgradeLock,
  retiredSourceCandidate,
  retiredSourceSettled,
  upgradeLock,
  useUpgradeLock,
} = await import("../src/features/migration/upgradeLock")

const ACCOUNT = "0xabc"

const RUN = `metadata-migration/${"0x" + "aa".repeat(20)}/${"0x" + "03".repeat(20)}/${ACCOUNT}`
const SOURCE = "0x" + "05".repeat(20)

afterEach(async () => {
  vi.restoreAllMocks()
  await webStorage.removeItem("metadata-migration/runs")
  await webStorage.removeItem(RUN)
  walletStorage.removeItem(`webwallet.upgradeLock/${ACCOUNT}`)
  walletStorage.removeItem(`webwallet.version/${ACCOUNT}`)
  walletStorage.removeItem(`webwallet.createdOn/${ACCOUNT}`)
  walletStorage.removeItem(
    `webwallet.retiredSourceRead/${"0x" + "aa".repeat(20)}/${SOURCE}/${ACCOUNT}`,
  )
})

describe("the upgrade lock", () => {
  it("reads as held until its release is saved, and stays held when saving fails", async () => {
    await acquireUpgradeLock(ACCOUNT, 7n)
    const commit = walletStorage.commitTransaction.bind(walletStorage)
    let save!: () => void
    // As the store does: reads see the write at once, and a write that fails to save is dropped.
    vi.spyOn(walletStorage, "commitTransaction").mockImplementationOnce(async (ops) => {
      const before = ops.map(([key]) => [key, walletStorage.getItem(key)] as const)
      for (const [key, value] of ops)
        value === null ? walletStorage.removeItem(key) : walletStorage.setItem(key, value)
      await new Promise<void>((resolve) => (save = resolve))
      for (const [key, value] of before)
        value === null ? walletStorage.removeItem(key) : walletStorage.setItem(key, value)
      throw new Error("disk full")
    })

    const released = releaseUpgradeLock(ACCOUNT)
    await vi.waitFor(() => expect(walletStorage.commitTransaction).toHaveBeenCalled())
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })
    save()
    await expect(released).rejects.toThrow("disk full")
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })

    vi.mocked(walletStorage.commitTransaction).mockImplementationOnce(commit)
    await releaseUpgradeLock(ACCOUNT)
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "released" })
  })

  it("has a second take wait on the first one's save, so neither holds when it fails", async () => {
    let save!: () => void
    vi.spyOn(walletStorage, "commitItem").mockImplementationOnce(async (key, value) => {
      walletStorage.setItem(key, value)
      await new Promise<void>((resolve) => (save = resolve))
      walletStorage.removeItem(key)
      throw new Error("disk full")
    })

    const first = acquireUpgradeLock(ACCOUNT, 7n)
    const second = acquireUpgradeLock(ACCOUNT, 7n)
    save()
    await expect(first).rejects.toThrow("disk full")
    await expect(second).rejects.toThrow("disk full")
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "pending" })
  })

  it("stays held while a run the account saved here is unfinished, wherever its source is", async () => {
    await webStorage.setItem("metadata-migration/runs", JSON.stringify([RUN]))
    await webStorage.setItem(RUN, JSON.stringify({ phase: "arriving" }))
    await acquireUpgradeLock(ACCOUNT, 7n)

    await expect(releaseUpgradeLock(ACCOUNT)).rejects.toThrow("unfinished")
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })

    await webStorage.setItem(RUN, JSON.stringify({ phase: "done" }))
    await releaseUpgradeLock(ACCOUNT)
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "released" })
  })

  it("keeps the figure the first start held", async () => {
    await acquireUpgradeLock(ACCOUNT, 7n)
    await acquireUpgradeLock(ACCOUNT, 9n)

    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })
  })

  it("stays unread until the account's runs are read", async () => {
    let read = () => false
    function Probe() {
      const { checked } = useUpgradeLock("0xdef")
      read = () => checked
      return null
    }
    const root = createRoot(document.createElement("div"))
    act(() => root.render(createElement(Probe)))
    vi.spyOn(webStorage, "getItem").mockRejectedValueOnce(new Error("store closed"))

    await act(async () => expect(checkUpgradeLock("0xdef")).rejects.toThrow("store closed"))
    expect(read()).toBe(false)
    await act(async () => checkUpgradeLock("0xdef"))
    expect(read()).toBe(true)
    act(() => root.unmount())
  })
})

describe("a source on another rollup", () => {
  const tip = (number: bigint) => ({ number, hash: `0x${number.toString(16)}` })
  const empty = (number: bigint, priorFinal: boolean) => ({
    empty: true as const,
    tip: tip(number),
    priorFinal,
  })

  it("settles only once the account is current here", async () => {
    await acquireUpgradeLock(ACCOUNT, 7n)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(100n, false))
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(200n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)

    await releaseUpgradeLock(ACCOUNT)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(300n, false))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(400n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(true)
    expect(retiredSourceSettled(ACCOUNT, "0x" + "06".repeat(20))).toBe(false)
  })

  it("keeps the block that closed its latest empty read until that block is final", async () => {
    await releaseUpgradeLock(ACCOUNT)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(100n, false))
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toEqual(tip(100n))
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(150n, false))
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toEqual(tip(150n))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)

    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(200n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(true)
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toBeUndefined()
  })

  it("starts over after a read that finds funds again", async () => {
    await releaseUpgradeLock(ACCOUNT)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(100n, false))
    recordRetiredSourceRead(ACCOUNT, SOURCE, { empty: false })
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toBeUndefined()

    // No earlier empty read is held, so nothing can be final yet.
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(200n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toEqual(tip(200n))
  })

  it("is read again while a new upgrade holds the account", async () => {
    await releaseUpgradeLock(ACCOUNT)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(100n, false))
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(200n, true))
    walletStorage.removeItem(`webwallet.version/${ACCOUNT}`)
    await acquireUpgradeLock(ACCOUNT, 7n)

    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
  })

  it("is settled for a new account made here", () => {
    markNewAccountHere(ACCOUNT)

    expect(upgradeLock(ACCOUNT)).toEqual({ state: "released" })
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(true)
  })

  it("is not settled for an account a passkey rotation made here, which keeps its keys", () => {
    markCreatedHere(ACCOUNT)

    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
  })

  it("is not settled for an account that upgraded here, before any read", async () => {
    await releaseUpgradeLock(ACCOUNT)

    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
  })
})
