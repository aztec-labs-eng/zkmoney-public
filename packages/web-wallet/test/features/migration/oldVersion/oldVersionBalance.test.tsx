import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, expect, it } from "vitest"
import { memoryStore, type BalanceEntry, type RecordSet } from "@obsidion/front-core"
import { setIdentity } from "../../../support/identity"
import {
  markOldHoldingsRead,
  markUpgradeMovesFunds,
  oldVersionScope,
  setOldVersionDestinations,
  useOldVersionHoldings,
} from "../../../../src/features/migration/oldVersionBalance"
import {
  acquireUpgradeLock,
  releaseUpgradeLock,
} from "../../../../src/features/migration/upgradeLock"
import { walletStorage } from "../../../../src/platform/storage/walletStorage"
import { sandboxConfig } from "../../../support/seedBootConfig"
import { seedDeviceKeys } from "../../../support/page"
import { openTestSession } from "../../../support/session"

const config = await sandboxConfig()
const PINNED = config.oxideProfile.portal.toLowerCase()
const session = () => openTestSession({ config })
beforeEach(async () => {
  // An account's session: it keeps the balance store.
  await seedDeviceKeys({ storageId: "acct" })
  session()
  await setIdentity({ address: "0xabc", claimedAt: 0 })
})

const wad = 10n ** 18n

it.each([[false, false]])(
  "keeps each old account's value recorded (already current: %s, new scan: %s)",
  async (current, scan) => {
    if (current) walletStorage.setItem("webwallet.version/0xabc", PINNED)
    if (scan)
      setOldVersionDestinations(
        config,
        PINNED,
        new Map([
          ["0xoldmain", { tuple: { portal: PINNED } }],
          ["0xoldsavings", { tuple: { portal: "0xsavings" } }],
        ]),
      )
    else
      walletStorage.setItem(
        `webwallet.oldSavingsSources/${PINNED}`,
        JSON.stringify(["0xoldsavings"]),
      )
    markOldHoldingsRead(config, "0xabc")
    const balances = session().balanceStore!
    await balances.write(oldVersionScope(config, "0xoldmain", "0xabc"), "0xtoken", 59n * wad)
    await balances.write(oldVersionScope(config, "0xoldsavings", "0xabc"), "0xshares", 40n * wad)
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

it("counts an upgraded account's old versions again while a later check offers to move them", async () => {
  // The upgrade did not see these funds, as when it could not read v5, and released the lock.
  walletStorage.setItem("webwallet.version/0xabc", PINNED)
  markOldHoldingsRead(config, "0xabc")
  const balances = session().balanceStore!
  await balances.write(oldVersionScope(config, "0xoldmain", "0xabc"), "0xtoken", 12n * wad)
  await balances.write(oldVersionScope(config, "0xoldsavings", "0xabc"), "0xshares", 0n)
  let shown!: ReturnType<typeof useOldVersionHoldings>
  function Holdings() {
    shown = useOldVersionHoldings()
    return null
  }
  const root = createRoot(document.createElement("div"))
  try {
    await act(async () => root.render(<Holdings />))
    // No check offers to move them: what is left is abandoned.
    expect(shown.main).toBe(0n)

    act(() => markUpgradeMovesFunds(config, "0xabc", true))
    expect(shown.main).toBe(12n * wad)
    expect(shown.total).toBe(12n * wad)

    // The upgrade that moves them takes the lock, whose figure counts them.
    await act(() => acquireUpgradeLock(config, "0xabc", 12n * wad))
    expect(shown.main).toBe(0n)

    // It finished: the next check offers nothing, and the lock opens.
    act(() => markUpgradeMovesFunds(config, "0xabc", false))
    await act(() => releaseUpgradeLock(config, "0xabc"))
    expect(shown.main).toBe(0n)
    expect(shown.total).toBe(0n)
  } finally {
    act(() => root.unmount())
  }
})

it("waits while the balance store has not read its records, or failed to", async () => {
  await setIdentity({ address: "0xdef", claimedAt: 0 })
  markOldHoldingsRead(config, "0xdef")
  walletStorage.setItem(`webwallet.oldSavingsSources/${PINNED}`, JSON.stringify([]))
  const view = memoryStore<RecordSet<BalanceEntry>>({ records: [], loaded: false, failed: false })
  const real = session().balanceStore
  Object.defineProperty(session(), "balanceStore", { configurable: true, value: { view } })
  let shown!: ReturnType<typeof useOldVersionHoldings>
  function Holdings() {
    shown = useOldVersionHoldings()
    return null
  }
  const root = createRoot(document.createElement("div"))
  try {
    await act(async () => root.render(<Holdings />))
    expect(shown.pending).toBe(true)
    act(() => view.set({ records: [], loaded: false, failed: true }))
    expect(shown.pending).toBe(true)
    act(() => view.set({ records: [], loaded: true, failed: false }))
    expect(shown.pending).toBe(false)
  } finally {
    act(() => root.unmount())
    Object.defineProperty(session(), "balanceStore", { configurable: true, value: real })
  }
})
