/**
 * The wallet chunk starts what the boot will wait on as soon as it runs: the fresh-origin check,
 * and bb.js's wasm, the PXE's largest download, except where no PXE boots on its own or another
 * tab runs the wallet.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  warmSyncBackend: vi.fn(async () => {}),
  originWasFresh: vi.fn(async () => true),
  getHardcodedArtifact: vi.fn(async (_name: string) => ({})),
}))
vi.mock("../../src/platform/barretenberg", () => ({ warmSyncBackend: h.warmSyncBackend })) // debt-check-ignore: the test counts the boot's warm-up calls; a real warm-up loads bb.js's wasm
vi.mock("../../src/platform/storage/freshOrigin", () => ({ originWasFresh: h.originWasFresh }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  getHardcodedArtifact: h.getHardcodedArtifact,
}))

import { warmBoot } from "../../src/bootWarmup"

afterEach(() => {
  vi.unstubAllGlobals()
  h.warmSyncBackend.mockClear()
  h.originWasFresh.mockClear()
  h.getHardcodedArtifact.mockClear()
})

describe("warmBoot", () => {
  it("loads a payment link's escrow artifact once bb.js is in, and nowhere else", async () => {
    await warmBoot("/")
    await Promise.resolve()
    expect(h.getHardcodedArtifact).not.toHaveBeenCalled()
    await warmBoot("/link")
    await vi.waitFor(() => expect(h.getHardcodedArtifact).toHaveBeenCalledWith("paylinkDirect"))
  })

  it.each(["/pay/brisk-otter", "/auth/google/callback"])(
    "leaves bb.js for later on %s, whose PXE may never boot",
    async (path) => {
      await warmBoot(path)
      expect(h.warmSyncBackend).not.toHaveBeenCalled()
      expect(h.originWasFresh).toHaveBeenCalledTimes(1)
    },
  )

  const locks = (held: string[]) =>
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: { query: async () => ({ held: held.map((name) => ({ name })), pending: [] }) },
    })

  it("leaves bb.js and a link's escrow artifact alone while another tab runs the wallet", async () => {
    locks(["webwallet.active-tab"])
    await warmBoot("/link")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.warmSyncBackend).not.toHaveBeenCalled()
    expect(h.getHardcodedArtifact).not.toHaveBeenCalled()
    expect(h.originWasFresh).toHaveBeenCalledTimes(1)
  })

  it("starts them when no tab holds the wallet", async () => {
    locks(["another-lock"])
    await warmBoot("/link")
    expect(h.warmSyncBackend).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.getHardcodedArtifact).toHaveBeenCalledWith("paylinkDirect"))
  })
})
