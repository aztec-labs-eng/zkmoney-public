/** Guards: the backup entry waits for its reads, fails closed, and counts Savings and refunds. */
import { act } from "react"
import { testPage, testCore } from "../../support/page"
import { assignReads } from "../../support/fakeReads"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../support/identity"
import { fixed, memoryStore, recordOf, type PaylinkTransaction } from "@obsidion/front-core"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const ONE_KEY = `0x${"11".repeat(32)}`
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
vi.mock("../../../src/config/oxideTuple", () => ({
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
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readBridgeDestination: async () => ({}),
  fundingAmount: async () => ({
    amount: 2n * DAI,
    credited: DAI,
    breakdown: { sweepTip: DAI / 2n },
  }),
  readSpendShape: async () => ({ notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI }),
}))

const { useBackupEntryFacts } = await import(
  "../../../src/features/backupPasskey/backupPasskeyFacts"
)
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../src/session/session"
)
const { openTestSession } = await import("../../support/session")
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

let entry: ReturnType<typeof useBackupEntryFacts> | undefined
let facts: ReturnType<typeof useBackupEntryFacts>["facts"] | undefined
function Probe() {
  entry = useBackupEntryFacts(true)
  facts = entry.facts
  return null
}

let container: HTMLDivElement
let root: Root
/** The session's paylink sweep: its latest pass's outcome, and the wakes the entry asked for. */
const rescanned = memoryStore<boolean | undefined>(undefined)
const wake = vi.fn()
const markPaylinksRescanned = (complete: boolean) => rescanned.set(complete)

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  rescanned.set(undefined)
  wake.mockClear()
  const open = switchSession(
    activeNamespace(testCore().device),
    pageSessionDeps({
      ...testPage(),
      wallClock: memoryStore(NOW * 1000).readonly,
      speedupEstimator: fixed("speedupEstimator", { calibrate: async () => undefined }) as never,
    }),
  )
  assignReads(open.page.chain, {
    currentTxAmountCap: async () => 5n * DAI,
    feeTokenBridgeTuple: async () => ({}),
  })
  Object.assign(open, {
    wallet: fixed("wallet", {
      node: { getL1Constants: async () => ({ epochDuration: 32, slotDuration: 36 }) },
    }),
    contractService: fixed("contractService", {}),
    savingsReplayed: memoryStore(true).readonly,
    paylinkSweep: {
      rescanned: rescanned.readonly,
      checking: memoryStore(false).readonly,
      recheck: wake,
    },
  })
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
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const links = () => (typeof facts === "object" ? facts.links : facts)
const sync = () =>
  act(async () => {
    openTestSession().milestones.mark("firstBalance")
    openTestSession().milestones.mark("movesReplayed")
  })

beforeEach(() => setIdentity({ address: ONE_KEY }))

describe("the backup entry's open paylinks on a fresh device", () => {
  beforeEach(sync)

  it("waits for the rescan, then counts the link it rebuilt after the entry mounted", async () => {
    await settle()
    expect(facts).toBe("checking")

    await act(async () => {
      await openTestSession().transfers.importHistoricRows([rebuilt])
      markPaylinksRescanned(true)
    })
    await settle()
    expect(links()).toBe(1)
  })

  it("reads unreadable while the latest pass failed, and its retry starts another", async () => {
    await act(async () => markPaylinksRescanned(false))
    await settle()
    expect(facts).toBe("unreadable")

    await act(async () => entry!.refresh())
    expect(wake).toHaveBeenCalledOnce()
    await act(async () => markPaylinksRescanned(true))
    await settle()
    expect(links()).toBe(0)
  })
})

describe("the backup entry's chain read", () => {
  it("stays on checking until the device has synced", async () => {
    await act(async () => markPaylinksRescanned(true))
    await settle()
    expect(facts).toBe("checking")

    await sync()
    await settle()
    expect(links()).toBe(0)
  })

  it("counts the sends that move Savings' shares beside Main Account's", async () => {
    moving = [...moving, { token: "0xsavings", cap: 2n * DAI }]
    await sync()
    await act(async () => markPaylinksRescanned(true))
    await settle()
    // Each balance reads 3 DAI: one send under Main's cap, two under Savings'.
    expect(typeof facts === "object" && facts.moves).toBe(3)
  })

  it("counts a link's refund into Main Account's move, and holds on a create in flight", async () => {
    await sync()
    await act(async () => {
      await openTestSession().transfers.importHistoricRows([
        { ...rebuilt, amountAtomic: (3n * DAI).toString() },
      ])
      markPaylinksRescanned(true)
    })
    await settle()
    // 3 DAI held and 3 DAI refunded move in two sends under a 5 DAI cap.
    expect(facts).toMatchObject({ links: 1, moves: 2 })
    expect(typeof facts === "object" && facts.linkHold).toBeUndefined()

    await act(async () => {
      // A create in flight: its link is filed, its operation not yet sent.
      const { operations, paylinks } = openTestSession()
      await operations.begin({ operationId: "create-1", flow: "paylink-create", summary: "$1" })
      const draft = recordOf({ ...rebuilt, payToEmailSecret: `0x${"66".repeat(32)}` })
      await paylinks.put({
        ...draft,
        operationId: "create-1",
        amountAtomic: DAI,
        txHash: undefined,
      })
    })
    await settle()
    expect(facts).toMatchObject({ links: 1, linkHold: { kind: "creating" } })
  })
})
