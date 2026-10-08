/** A tab publishes its PXE boot's outcome, and reports a failure, only while it is the active tab. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { AztecSQLiteOPFSStore } from "@aztec/kv-store/sqlite-opfs"
import type { PxeBootTarget } from "../src/ui/PxeBoot"
import { resetModulesAsActiveTab } from "./support/activeTab"

const h = vi.hoisted(() => ({
  initializePXE: vi.fn(),
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAztecContext: () => ({ currentNetwork: "sandbox", initializePXE: h.initializePXE }),
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: h.fireEvent }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ proverEnabled: false }) }))

function deferred() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const IDENTITY = {
  l1ChainId: 31337,
  rollupVersion: "1",
  rollupAddress: "0x" + "a".repeat(40),
  inboxAddress: "0x" + "b".repeat(40),
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  h.initializePXE.mockReset()
  h.showReportableError.mockReset()
  h.fireEvent.mockReset()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

/** Each mount is a new page: the boot runs once per page. */
async function mount(
  pxeBoot: PxeBootTarget = {
    kind: "pxe",
    store: {} as AztecSQLiteOPFSStore,
    identity: IDENTITY,
    bootStartedAt: 0,
    attempts: 1,
  },
) {
  await resetModulesAsActiveTab()
  const { PxeBootProvider, usePxeBoot } = await import("../src/ui/PxeBoot")
  const { revokeTab } = await import("../src/platform/storage/activeTab")
  function Status() {
    return <span>{usePxeBoot().bootStatus}</span>
  }
  await act(async () => {
    root.render(
      <PxeBootProvider node={{} as AztecNode} pxeBoot={pxeBoot}>
        <Status />
      </PxeBootProvider>,
    )
  })
  return { revokeTab, status: () => container.textContent }
}

describe("PxeBootProvider", () => {
  it("publishes ready once the PXE boots on the identity the gate checked", async () => {
    h.initializePXE.mockResolvedValue(undefined)
    const page = await mount()
    await flush()
    expect(page.status()).toBe("ready")
    expect(h.initializePXE).toHaveBeenCalledWith(
      expect.objectContaining({ chainIdentity: IDENTITY }),
    )
  })

  it("publishes and reports a boot that fails while this tab is active", async () => {
    const error = new Error("boot failed")
    h.initializePXE.mockRejectedValue(error)
    const page = await mount()
    await flush()
    expect(page.status()).toBe("error")
    expect(h.showReportableError).toHaveBeenCalledWith(error, "pxe:boot", expect.anything())
    expect(h.fireEvent).toHaveBeenCalledWith(
      "pxe_boot_failed",
      expect.objectContaining({ code: "other" }),
    )
  })

  it("publishes ready in demo mode without booting a PXE", async () => {
    const page = await mount({ kind: "demo" })
    await flush()
    expect(page.status()).toBe("ready")
    expect(h.initializePXE).not.toHaveBeenCalled()
  })

  it.each(["boots", "fails"])(
    "stays booting when another tab takes over while the PXE %s",
    async (outcome) => {
      const boot = deferred()
      h.initializePXE.mockReturnValue(boot.promise)
      const page = await mount()
      page.revokeTab()
      if (outcome === "boots") boot.resolve()
      else boot.reject(new Error("store closed"))
      await flush()
      expect(page.status()).toBe("booting")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(h.fireEvent).not.toHaveBeenCalledWith("pxe_boot_failed", expect.anything())
    },
  )
})
