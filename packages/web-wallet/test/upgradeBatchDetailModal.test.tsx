import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import type { UpgradeBatchItem } from "@obsidion/front-core"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", nodeUrl: "http://localhost:8080" }),
}))

const { UpgradeBatchDetailModal } = await import("../src/ui/screens/UpgradeBatchDetailModal")

const batch: UpgradeBatchItem = {
  run: "run",
  id: "remaining-0",
  first: false,
  recipient: `0x${"5a".repeat(20)}`,
  amount: (10n * 10n ** 18n).toString(),
  exitFee: (10n ** 17n).toString(),
  state: "refunded",
  approved: true,
  tx: `0x${"b0".repeat(32)}`,
  startTime: 1_000,
}

describe("upgrade batch details", () => {
  it("shows the refund's state, its tip, where it went and the send that carried it", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<UpgradeBatchDetailModal batch={batch} onClose={() => {}} />))
    const text = document.body.textContent ?? ""
    expect(text).toContain("$10")
    expect(text).toContain("Releasing")
    expect(text).toContain("Relayer tip$0.10")
    expect(text).toContain("Paid to")
    expect(text).toContain("Sent in")
    await act(async () => root.unmount())
    container.remove()
  })
})
