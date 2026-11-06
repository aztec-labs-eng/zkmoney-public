/**
 * The backup entry's facts on a fresh device. Its links reach storage only once the rescan rebuilds
 * them from chain, after the entry mounted, so the entry waits for that rescan and reads again as
 * rows land. It also waits for the device to sync and the Savings moves replay to end, and counts
 * Savings' shares and the links' refunds in the move.
 */
import { act } from "react"
import { testPage, testCore } from "../../support/page"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../support/identity"
import type { PaylinkTransaction } from "@obsidion/front-core"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const ONE_KEY = `0x${"11".repeat(32)}`
const OTHER = `0x${"22".repeat(32)}`
const NOW = 1_800_000_000

vi.mock("../../../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ hydrated: true, records: [] }),
}))
vi.mock("../../../src/features/migration/oldVersionBalance", () => ({
  useOldVersionHoldings: () => ({ pending: false, total: 0n }),
}))
vi.mock("../../../src/features/migration/upgradeLock", () => ({
  useUpgradeLock: () => ({ state: "released" }),
}))
vi.mock("../../../src/features/registration/registrationResume", () => ({
  unlockedSessionKeys: async () => ({
    account: { getAddress: () => ({ toString: () => ONE_KEY }) },
  }),
}))
const DAI = 10n ** 18n
vi.mock("../../../src/features/token/oxideToken", () => ({
  currentTxAmountCap: async () => 5n * DAI,
}))
vi.mock("../../../src/config/classArtifacts", () => ({ getWebOxideToken: async () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({
  getFeeTokenBridgeTuple: async () => ({}),
  l1PublicClient: () => ({}),
  requireTupleField: () => "0x",
}))
/** What the add moves, as each test sets it: Main Account's token, and Savings' shares. */
let moving = [{ token: "0xmain", cap: 5n * DAI }]
vi.mock("../../../src/features/backupPasskey/backupMoveTokens", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/features/backupPasskey/backupMoveTokens")
  >()),
  readMoveBalances: async () =>
    moving.map(({ token, cap }) => ({
      token,
      cap,
      shape: { notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI },
    })),
}))
/** The Savings moves replay's outcome, and whether their store read storage. */
let replayed: boolean | undefined = true
let movesLoaded = true
vi.mock("../../../src/features/savings/savingsTasks", () => ({
  useSavingsMovesReplayed: () => replayed,
}))
vi.mock("../../../src/features/savings/savingsMoveStore", () => ({
  getSavingsMoveStore: () => ({
    load: async () => {},
    isLoaded: () => movesLoaded,
    list: () => [],
    onListChanged: () => () => {},
  }),
}))
/** Wall time as the entry reads it, set by each test. */
let nowMs = NOW * 1000
const ticks = new Set<() => void>()
vi.mock("../../../src/lib/clock", () => ({
  wallClock: {
    get: () => nowMs,
    subscribe: (listener: () => void) => {
      ticks.add(listener)
      return () => ticks.delete(listener)
    },
  },
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({}),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readBridgeDestination: async () => ({}),
  fundingAmount: async () => ({ amount: 2n * DAI, credited: DAI, breakdown: {} }),
  readSpendShape: async () => ({ notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI }),
}))

const { useBackupEntryFacts } = await import(
  "../../../src/features/backupPasskey/backupPasskeyFacts"
)
const { markPaylinksRescanned, providePaylinkRescan } = await import(
  "../../../src/features/paylink/paylinkRescanState"
)
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/session/session"
)
const { pageSessionDeps } = await import("../../../src/app/sessionDeps")

/** A link the account made on another device, as the rescan rebuilds it. */
const rebuilt: PaylinkTransaction = {
  action: "Pay To Email",
  emailPaymentAction: "Pay To Email",
  flavor: "direct",
  status: "success",
  timestamp: (NOW - 600) * 1000,
  txHash: `0x${"ab".repeat(32)}`,
  paylink: "https://wallet.example/link#frag",
  payToEmailSecret: `0x${"44".repeat(32)}`,
  fallbackSecret: `0x${"55".repeat(32)}`,
  obsidionAccountAddress: ONE_KEY,
  fromClaimable: 0,
  untilClaimable: NOW + 86_400,
  refundableUntil: NOW + 86_400,
} as PaylinkTransaction

const wallet = {} as never
const contractService = {} as never
let entry: ReturnType<typeof useBackupEntryFacts> | undefined
let facts: ReturnType<typeof useBackupEntryFacts>["facts"] | undefined
function Probe() {
  entry = useBackupEntryFacts(wallet, contractService, true)
  facts = entry.facts
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // A pass for another account leaves this one's unread.
  markPaylinksRescanned(OTHER, true)
  const { activity } = switchSession(
    activeNamespace(testCore().device),
    pageSessionDeps(testPage()),
  )
  for (const row of await activity.all()) await activity.remove(row.id)
  facts = undefined
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Probe />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  closeSession()
  moving = [{ token: "0xmain", cap: 5n * DAI }]
  replayed = true
  movesLoaded = true
  nowMs = NOW * 1000
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const tickTo = (sec: number) =>
  act(async () => {
    nowMs = sec * 1000
    for (const listener of [...ticks]) listener()
  })
let mounts = 0
/** Mounts the entry again, so it reads what the test set since. */
const remount = () => act(async () => root.render(<Probe key={++mounts} />))
const links = () => (typeof facts === "object" ? facts.links : facts)
const sync = () =>
  act(async () => {
    session().milestones.mark("firstBalance")
    session().milestones.mark("movesReplayed")
  })

beforeEach(() => setIdentity({ address: ONE_KEY }))

describe("the backup entry's open paylinks on a fresh device", () => {
  beforeEach(sync)

  it("waits for the rescan, then counts the link it rebuilt after the entry mounted", async () => {
    await settle()
    expect(facts).toBe("checking")

    await act(async () => {
      await session().activity.importHistoricRows([rebuilt])
      markPaylinksRescanned(ONE_KEY, true)
    })
    await settle()
    expect(links()).toBe(1)
  })

  it("counts a link that lands after the rescan finished", async () => {
    await act(async () => markPaylinksRescanned(ONE_KEY, true))
    await settle()
    expect(links()).toBe(0)

    await act(async () => {
      await session().activity.importHistoricRows([rebuilt])
    })
    await settle()
    expect(links()).toBe(1)
  })

  it("reads unreadable while the latest pass failed, and its retry starts another", async () => {
    const rerun = vi.fn()
    const withdraw = providePaylinkRescan(rerun)
    await act(async () => markPaylinksRescanned(ONE_KEY, false))
    await settle()
    expect(facts).toBe("unreadable")

    await act(async () => entry!.refresh())
    expect(rerun).toHaveBeenCalledOnce()
    await act(async () => markPaylinksRescanned(ONE_KEY, true))
    await settle()
    expect(links()).toBe(0)
    withdraw()
  })
})

describe("the backup entry's chain read", () => {
  it("stays on checking until the device has synced", async () => {
    await act(async () => markPaylinksRescanned(ONE_KEY, true))
    await settle()
    expect(facts).toBe("checking")

    await sync()
    await settle()
    expect(links()).toBe(0)
  })

  it("counts the sends that move Savings' shares beside Main Account's", async () => {
    moving = [...moving, { token: "0xsavings", cap: 2n * DAI }]
    await sync()
    await act(async () => markPaylinksRescanned(ONE_KEY, true))
    await settle()
    // Each balance reads 3 DAI: one send under Main's cap, two under Savings'.
    expect(typeof facts === "object" && facts.moves).toBe(3)
  })

  it("counts a link's refund into Main Account's move, and holds on a create in flight", async () => {
    await sync()
    await act(async () => {
      await session().activity.importHistoricRows([
        { ...rebuilt, amountAtomic: (3n * DAI).toString() },
      ])
      markPaylinksRescanned(ONE_KEY, true)
    })
    await settle()
    // 3 DAI held and 3 DAI refunded move in two sends under a 5 DAI cap.
    expect(facts).toMatchObject({ links: 1, moves: 2 })
    expect(typeof facts === "object" && facts.linkHold).toBeUndefined()

    await act(async () => {
      await session().activity.insertPending({
        ...rebuilt,
        id: "create-1",
        networkId: "0x01",
        amountAtomic: DAI,
        txHash: "",
        status: "pending",
        payToEmailSecret: `0x${"66".repeat(32)}`,
      })
    })
    await settle()
    expect(facts).toMatchObject({ links: 1, linkHold: { kind: "creating" } })
  })

  it("lifts a link's expiry hold once it expires, with the entry still open", async () => {
    await sync()
    await act(async () => {
      // Its cancel window has all but closed, well before its expiry.
      await session().activity.importHistoricRows([
        { ...rebuilt, refundableUntil: NOW + 10, untilClaimable: NOW + 60 },
      ])
      markPaylinksRescanned(ONE_KEY, true)
    })
    await settle()
    expect(facts).toMatchObject({ links: 0, linkHold: { kind: "expiry", until: NOW + 60 } })

    await tickTo(NOW + 61)
    await settle()
    expect(facts).toMatchObject({ links: 1 })
    expect(typeof facts === "object" && facts.linkHold).toBeUndefined()
  })
})

describe("the backup entry's Savings moves", () => {
  beforeEach(async () => {
    await sync()
    await act(async () => markPaylinksRescanned(ONE_KEY, true))
  })

  it("stays on checking until the replay ends, and reads unreadable while it failed", async () => {
    replayed = undefined
    await remount()
    await settle()
    expect(facts).toBe("checking")

    replayed = false
    await remount()
    await settle()
    expect(facts).toBe("unreadable")

    replayed = true
    await remount()
    await settle()
    expect(links()).toBe(0)
  })

  it("reads unreadable while their store could not read storage, and its retry reads again", async () => {
    movesLoaded = false
    await remount()
    await settle()
    expect(facts).toBe("unreadable")

    movesLoaded = true
    await act(async () => entry!.refresh())
    await settle()
    expect(links()).toBe(0)
  })
})
