// @vitest-environment node
/** The page's wallet boot: a failed module download reloads twice at most, and a failure is final. */
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { AztecSQLiteOPFSStore } from "@aztec-labs/kv-store/sqlite-opfs"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { CreateWallet, PxeTarget } from "../../src/platform/wallet"
import { sandboxProfile } from "../fixtures/sandboxProfile"
import { resetModulesAsActiveTab } from "../support/activeTab"
import { testWalletDbs } from "../support/fakeWalletDb"

const TARGET: PxeTarget = {
  kind: "pxe",
  store: {} as AztecSQLiteOPFSStore,
  identity: {
    l1ChainId: 31337,
    rollupVersion: "1",
    rollupAddress: "0x" + "a".repeat(40),
    inboxAddress: "0x" + "b".repeat(40),
  },
  bootStartedAt: 0,
  attempts: 1,
}

const DOWNLOAD = () => new TypeError("Failed to fetch dynamically imported module: /pxe.js")
const BOOTED = () => Promise.resolve({ node: {} } as never)

// Each page re-evaluates the wallet's module graph, which is slow under coverage.
vi.setConfig({ testTimeout: 30_000 })

// The first import transforms the wallet's module graph; each page after it only evaluates it.
beforeAll(() => import("../../src/platform/wallet"), 60_000)

let stash: Map<string, string>
let refused: "get" | "remove" | undefined
let reload: ReturnType<typeof vi.fn>
beforeEach(() => {
  stash = new Map()
  refused = undefined
  reload = vi.fn()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => {
      if (refused === "get") throw new Error("refused")
      return stash.get(key) ?? null
    },
    setItem: (key: string, value: string) => void stash.set(key, value),
    removeItem: (key: string) => {
      if (refused === "remove") throw new Error("refused")
      stash.delete(key)
    },
  })
  vi.stubGlobal("location", { reload })
  // Node 20 has no `navigator`; the boot reads its user agent.
  vi.stubGlobal("navigator", { userAgent: "node", maxTouchPoints: 0 })
})
afterEach(() => vi.unstubAllGlobals())

/** One page load: fresh modules, as the active tab, booting with `create`. */
async function page(create: CreateWallet) {
  await resetModulesAsActiveTab()
  // `reloadPage` flushes the wallet store before it reloads.
  const storage = await import("../../src/platform/storage/walletStorage")
  storage.__setWalletDbBackendForTests(testWalletDbs())
  await storage.openWalletStore(sandboxProfile().shared.rollupVersion, { persistent: false })
  const wallet = await import("../../src/platform/wallet")
  const tab = await import("../../src/platform/storage/activeTab")
  const pageWallet = wallet.createPageWallet({} as never)
  pageWallet.openWallet({} as AztecNode, TARGET, create)
  pageWallet.wantWallet()
  return {
    built: pageWallet.wallet,
    revokeTab: tab.revokeTab,
    NodeUnreachableError: wallet.NodeUnreachableError,
  }
}

/** Boots one page to a final state, or to the reload a failed download asks for. */
async function boot(create: CreateWallet) {
  const reloads = reload.mock.calls.length
  const { built, NodeUnreachableError } = await page(create)
  await vi.waitFor(() => {
    expect(built.get().status !== "pending" || reload.mock.calls.length > reloads).toBe(true)
  })
  return { state: built.get(), NodeUnreachableError }
}

describe("the page wallet's boot", () => {
  it("reloads after a failed module download twice, then fails", async () => {
    const create: CreateWallet = () => Promise.reject(new AggregateError([DOWNLOAD()]))
    await boot(create)
    await boot(create)
    expect(reload).toHaveBeenCalledTimes(2)
    expect((await boot(create)).state.status).toBe("failed")
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("gives a boot after a successful one its own two reloads", async () => {
    const fail: CreateWallet = () => Promise.reject(DOWNLOAD())
    await boot(fail)
    expect((await boot(BOOTED)).state.status).toBe("ready")
    await boot(fail)
    await boot(fail)
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it("fails without a reload when the tab cannot count its reloads", async () => {
    refused = "get"
    expect((await boot(() => Promise.reject(DOWNLOAD()))).state.status).toBe("failed")
    expect(reload).not.toHaveBeenCalled()
  })

  it("is ready when the tab cannot clear its reload count", async () => {
    refused = "remove"
    expect((await boot(BOOTED)).state.status).toBe("ready")
  })

  it("names a node that did not answer, and never reloads for it", async () => {
    const transport = Object.assign(new Error("rpc"), {
      cause: { data: new Error("fetch failed") },
    })
    const { state, NodeUnreachableError } = await boot(() => Promise.reject(transport))
    const error = state.status === "failed" ? state.error : undefined
    expect(error).toBeInstanceOf(NodeUnreachableError)
    expect((error as Error).cause).toBe(transport)
    expect(reload).not.toHaveBeenCalled()
  })

  it("stays pending, without a reload, when another tab took over while it booted", async () => {
    let fail!: (e: Error) => void
    const { built, revokeTab } = await page(() => new Promise((_, reject) => (fail = reject)))
    await vi.waitFor(() => expect(fail).toBeDefined())
    revokeTab()
    fail(DOWNLOAD())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(built.get().status).toBe("pending")
    expect(reload).not.toHaveBeenCalled()
  })
})
