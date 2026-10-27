import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { BalanceStorage } from "@obsidion/front-core"

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { portal: "0xcurrent" } }),
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ address: "0xabc" }),
}))

const { walletStorage } = await import("../src/platform/storage/walletStorage")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
const { oldVersionScope, setOldVersionDestinations, markOldHoldingsRead, useOldVersionHoldings } =
  await import("../src/features/migration/oldVersionBalance")
const wad = 10n ** 18n

afterEach(() => walletStorage.removeItem("webwallet.version/0xabc"))

it.each([
  [false, false],
  [false, true],
  [true, true],
])(
  "keeps each old account's value recorded (already current: %s, new scan: %s)",
  async (current, scan) => {
    if (current) walletStorage.setItem("webwallet.version/0xabc", "0xcurrent")
    if (scan)
      setOldVersionDestinations(
        "0xcurrent",
        new Map([
          ["0xoldmain", { tuple: { portal: "0xcurrent" } }],
          ["0xoldsavings", { tuple: { portal: "0xsavings" } }],
        ]),
      )
    else
      walletStorage.setItem(
        "webwallet.oldSavingsSources/0xcurrent",
        JSON.stringify(["0xoldsavings"]),
      )
    markOldHoldingsRead("0xabc")
    const balances = BalanceStorage.get(webStorage)
    await balances.updateBalance(oldVersionScope("0xoldmain", "0xabc"), "0xtoken", 59n * wad)
    await balances.updateBalance(oldVersionScope("0xoldsavings", "0xabc"), "0xshares", 40n * wad)
    let shown!: ReturnType<typeof useOldVersionHoldings>
    function Holdings() {
      shown = useOldVersionHoldings()
      return null
    }
    const root = createRoot(document.createElement("div"))
    try {
      await act(async () => root.render(<Holdings />))
      expect(shown.recordedMain).toBe(59n * wad)
      expect(shown.recordedSavings).toBe(40n * wad)
      expect(shown.main).toBe(current ? 0n : 59n * wad)
      expect(shown.savings).toBe(current ? 0n : 40n * wad)
      expect(shown.total).toBe(shown.main + shown.savings)
      expect(shown.pending).toBe(false)
    } finally {
      act(() => root.unmount())
    }
  },
)
