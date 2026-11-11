/**
 * Guards the boot view decides: a node or profile that L1 disagrees with is refused before the PXE
 * store opens, a damaged store and a failed boot each offer a way out, a tab that is not active
 * keeps an inbound name grant, and old wallet keys stay until this tab holds the wallet.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { PageBoot } from "../../src/app/sessionDeps"
import type { WebBootConfig } from "../../src/config/env"
import { ACTIVE_TAB_LOCK } from "../../src/platform/storage/activeTabLifecycle"
import { sandboxProfile } from "../fixtures/sandboxProfile"
import { FakeLocks } from "../support/fakeLocks"

const h = vi.hoisted(() => ({
  app: vi.fn(),
  store: { close: vi.fn(async () => {}) },
  createPxeStore: vi.fn(),
  nodeRollup: "",
  profileRollup: "",
  nodeDigest: undefined as string | undefined,
  readPortal: vi.fn(),
  reload: vi.fn(async () => {}),
}))
vi.mock("../../src/App", () => ({
  App: (props: unknown) => {
    h.app(props)
    return <div>Wallet ready</div>
  },
}))
vi.mock("../../src/platform/storage/createPxeStore", () => ({
  createPxeStore: h.createPxeStore,
  opfsAvailable: async () => false,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNode: () => ({
    getNodeInfo: async () => ({
      l1ChainId: 31337,
      rollupVersion: h.nodeRollup,
      l1ContractAddresses: {
        rollupAddress: { toString: () => "0xrollup" },
        inboxAddress: { toString: () => "0xinbox" },
      },
    }),
    getBlock: async () => undefined,
  }),
  readPortalChainIdentity: h.readPortal,
}))
vi.mock("../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../../src/platform/storage/walletStorage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reloadPage: h.reload,
}))

const ROLLUP = sandboxProfile().shared.rollupVersion
const boot = { config: { rpId: "auth.zk.money" } } as WebBootConfig
const locks = Object.getOwnPropertyDescriptor(navigator, "locks")!
let container: HTMLDivElement
let root: Root

// The first import of the wallet's module graph takes seconds; pay for it outside any one test.
beforeAll(async () => {
  await import("../../src/BootGate")
}, 60_000)

beforeEach(() => {
  // The gate keeps one lifecycle per page; each test is a new page.
  vi.resetModules()
  localStorage.clear()
  h.app.mockClear()
  h.reload.mockClear()
  h.createPxeStore.mockReset().mockResolvedValue(h.store)
  h.nodeRollup = ROLLUP
  h.profileRollup = ROLLUP
  h.nodeDigest = undefined
  // L1 names the rollup the profile does.
  h.readPortal.mockReset().mockImplementation(async () => ({
    l1ChainId: 31337,
    rollupVersion: h.profileRollup,
    rollupAddress: "0xrollup",
    inboxAddress: "0xinbox",
  }))
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  container.remove()
  history.replaceState(null, "", "/")
  Object.defineProperty(navigator, "locks", locks)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// An unmount leaves the splash waiting for page text, then fading on a timer that would outlive the
// environment. Text ends every wait at the next frame; the fade takes 200ms.
afterAll(async () => {
  const page = document.createElement("div")
  page.id = "root"
  page.textContent = "wallet"
  document.body.appendChild(page)
  await new Promise((resolve) => setTimeout(resolve, 300))
})

const stubLocks = (value: unknown) =>
  Object.defineProperty(navigator, "locks", { configurable: true, value })

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

/** How the OPFS pool refuses a database another tab holds. */
const busyError = () => Object.assign(new Error("pool is busy"), { name: "SqlitePoolBusyError" })

/** A page from this test's module graph, on this test's node and profile rollup, claiming the tab. */
async function testPage() {
  const { defaultConfig } = await import("../support/page")
  const config = {
    ...defaultConfig,
    nodeUrl: "http://node",
    nodeEndpointDigest: h.nodeDigest,
    profileRollupVersion: h.profileRollup,
  }
  const page = (await import("../support/session")).sessionPage(undefined, { config })
  ;(await import("../../src/ActiveTabGate/ActiveTabGate")).claimActiveTab(page)
  return page
}

/** The boot over a page from this test's module graph. */
const booted = async (): Promise<PageBoot> => ({ ...boot, page: await testPage() })

async function render(resolveBoot?: () => Promise<PageBoot>) {
  const { BootGate } = await import("../../src/BootGate")
  const { testQuery } = await import("../support/query")
  const ready = resolveBoot ? undefined : await booted()
  const read = testQuery()<[], PageBoot>("boot", {
    load: resolveBoot ?? (async () => ready!),
  })()
  await act(async () => {
    root.render(
      <React.StrictMode>
        <BootGate boot={read} />
      </React.StrictMode>,
    )
  })
  await flush()
}

const button = (label: string) =>
  [...container.querySelectorAll<HTMLElement>('button, [role="button"]')].find((b) =>
    b.textContent?.includes(label),
  )

describe("BootGate", () => {
  it("takes an inbound name grant out of the URL while another tab is active", async () => {
    const fake = new FakeLocks()
    stubLocks(fake)
    void fake.request(ACTIVE_TAB_LOCK, {}, () => new Promise(() => {})).catch(() => {})
    history.replaceState(null, "", "/claim/alice?grant=secret&entry=passkey")
    await render()
    expect(container.textContent).toContain("zk.money is open in another tab")
    expect(location.pathname + location.search).toBe("/claim/alice?entry=passkey")
    expect(sessionStorage.getItem("obsidion.name-grant")).toBe("secret")
  })

  describe("old wallet keys in localStorage", () => {
    const oldKeys = () => [
      "webwallet.msk",
      `rollup.${ROLLUP}.webwallet.msk`,
      "rollup.8.webwallet.identity",
    ]
    const seed = () => {
      for (const key of oldKeys()) localStorage.setItem(key, "old")
      localStorage.setItem("zkm_bid", "device")
    }
    const present = () => oldKeys().filter((key) => localStorage.getItem(key) !== null)

    it("stay while another tab holds the PXE store, and go once this tab is active", async () => {
      stubLocks(new FakeLocks())
      seed()
      let whileBusy: string[] = []
      h.createPxeStore
        .mockImplementationOnce(async () => {
          whileBusy = present()
          throw busyError()
        })
        .mockImplementationOnce(async () => h.store)
      await render()
      await act(() => vi.waitFor(() => expect(container.textContent).toContain("Wallet ready")))
      expect(whileBusy).toEqual(oldKeys())
      expect(present()).toEqual([])
      expect(localStorage.getItem("zkm_bid")).toBe("device")
    })

    it("stay when the boot fails before the tab is ready", async () => {
      stubLocks(new FakeLocks())
      vi.spyOn(console, "error").mockImplementation(() => {})
      h.nodeRollup = `${ROLLUP}9`
      seed()
      await render()
      expect(button("Retry")).toBeDefined()
      expect(present()).toEqual(oldKeys())
    })

    it("do not stop the wallet mounting when they cannot be removed", async () => {
      stubLocks(new FakeLocks())
      vi.spyOn(console, "warn").mockImplementation(() => {})
      seed()
      const remove = Storage.prototype.removeItem
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
        if (oldKeys().includes(key)) throw new Error("SecurityError")
        remove.call(this, key)
      })
      await render()
      expect(container.textContent).toContain("Wallet ready")
    })
  })

  it("offers the reset page, without a retry, when the PXE store is damaged", async () => {
    stubLocks(new FakeLocks())
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { SqliteCorruptionError } = await import("@aztec-labs/kv-store/sqlite-opfs")
    h.createPxeStore.mockRejectedValue(
      new SqliteCorruptionError("database disk image is malformed"),
    )
    await render()
    await vi.waitFor(() => expect(button("Clear wallet data")).toBeDefined(), { timeout: 10_000 })
    expect(button("Retry")).toBeUndefined()
  }, 20_000)

  it("refuses a node L1 disagrees with before the PXE store opens, and offers the editor", async () => {
    stubLocks(new FakeLocks())
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.nodeRollup = `${ROLLUP}9`
    await render()
    const screen = container.querySelector<HTMLElement>('[data-testid="boot-error"]')
    expect(screen?.dataset.kind).toBe("mismatch")
    expect(screen?.textContent).toContain("The node at http://node is not on this rollup")
    expect(h.createPxeStore).not.toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()
    // The wallet database is closed here, so the editor must open without it.
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="boot-change-endpoints"]')!.click(),
    )
    expect(container.querySelector('dialog[aria-label="Endpoints"]')).not.toBeNull()
  })

  it("refuses a profile L1 disagrees with before the PXE store opens", async () => {
    stubLocks(new FakeLocks())
    h.profileRollup = `${ROLLUP}9`
    h.readPortal.mockResolvedValue({
      l1ChainId: 31337,
      rollupVersion: ROLLUP,
      rollupAddress: "0xrollup",
      inboxAddress: "0xinbox",
    })
    await render()
    const screen = container.querySelector<HTMLElement>('[data-testid="boot-error"]')
    expect(screen?.dataset.kind).toBe("profile-skew")
    expect(h.createPxeStore).not.toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()
  })

  it("opens a custom node's PXE store under its endpoint digest", async () => {
    stubLocks(new FakeLocks())
    h.nodeDigest = "0123456789abcdef0123456789abcdef"
    await render()
    expect(container.textContent).toContain("Wallet ready")
    expect(h.createPxeStore).toHaveBeenCalledWith("0xrollup", h.nodeDigest)
  })

  it("retries a configuration failure", async () => {
    stubLocks(new FakeLocks())
    const resolveBoot = vi
      .fn<() => Promise<PageBoot>>()
      .mockRejectedValueOnce(new Error("profile unreachable"))
      .mockImplementationOnce(booted)
    await render(resolveBoot)
    expect(container.textContent).toContain("profile unreachable")
    expect(h.app).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click())
    await flush()
    expect(resolveBoot).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Wallet ready")
  })
})
