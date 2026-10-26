import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HistoricResidualSummary } from "../src/features/migration/historicResiduals"
import type { MigrationSourceQuote } from "@obsidion/sdk"
import { provingProgress } from "@obsidion/proving-progress"
import { asOperation, endSigningAndHandOff } from "./support/handOff"
import { startTabBoundOperation } from "./support/operations"

const BOOTED_PORTAL = "0x" + "AA".repeat(20)
const ACCOUNT = { getAddress: () => ({ toString: () => "0xabc" }) }

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  reconcile: vi.fn(),
  live: vi.fn(),
  metadataSession: vi.fn(),
  runMetadata: vi.fn(),
  aztec: { obsidionWallet: {} },
  account: { obsidionAccount: {} as unknown },
  asset: { current: { tokenService: undefined as unknown, loadAssets: async () => {} } },
  contracts: { contractService: {} },
  migrate: vi.fn(),
  fee: vi.fn(),
  railPending: undefined as boolean | undefined,
  railReadFailed: false,
  balance: { walletBalance: "0.00", balanceKnown: true },
  registrations: [] as { l2Address: string }[],
  demo: false,
  deposit: undefined as
    | undefined
    | { title?: string; target?: import("../src/features/deposit/depositTarget").DepositTarget },
}))

// A real notification store on memory, so a dismiss and the next scan's upsert meet as they would.
const notes = vi.hoisted(() => ({
  store: undefined as unknown as import("@obsidion/front-core").AppNotificationStore,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@obsidion/front-core")>()
  const memory = new Map<string, string>()
  notes.store = new real.AppNotificationStore({
    getItem: async (k: string) => memory.get(k) ?? null,
    setItem: async (k: string, v: string) => void memory.set(k, v),
    removeItem: async (k: string) => void memory.delete(k),
    clear: async () => memory.clear(),
  } as never)
  return {
    ...real,
    useAztecContext: () => h.aztec,
    useAccountContext: () => h.account,
    useAssetContext: () => h.asset.current,
    useBalance: () => h.balance,
    useContractServiceContext: () => h.contracts,
    bootPriority: { whenReady: async () => {} },
    checkSpentViaPaylinkService: () => async () => new Map(),
    AppNotificationStore: { get: () => notes.store },
    runMetadataMigration: h.runMetadata,
  }
})
// The DS drags in liquid-glass optics jsdom can't render; these tests are about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: () => null,
  Icon: () => null,
  GradientSpinner: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label} {value}
    </div>
  ),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {},
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// The screen's own tests cover it; these check the target the dialog hands it.
vi.mock("../src/features/deposit/DepositScreen", () => ({
  DepositScreen: (props: NonNullable<typeof h.deposit>) => {
    h.deposit = props
    return <div data-testid="deposit-screen">{props.title}</div>
  },
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { portal: "0x" + "AA".repeat(20) } }),
  fetchLiveProfilePortal: h.live,
}))
vi.mock("../src/features/migration/probeAccountResiduals", () => ({
  probeAccountResiduals: h.probe,
  reconcilePendingPaylinks: h.reconcile,
}))
vi.mock("../src/features/migration/createWebMetadataMigration", () => ({
  createWebMetadataMigration: async (...args: unknown[]) => ({
    holdings: async () => true,
    ...(await h.metadataSession(...args)),
  }),
  webMetadataMigrationKey: () => "migration-test",
}))
vi.mock("../src/features/onboarding/sponsoredRailReadiness", () => ({
  useSponsoredRailPending: () => h.railPending,
  useSponsoredRailReadFailed: () => h.railReadFailed,
}))
vi.mock("../src/features/onboarding/webRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/webRegistration")>()),
  getPendingStore: () => ({ load: async () => {}, list: () => h.registrations }),
}))
vi.mock("../src/dev/demoFlag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev/demoFlag")>()),
  isDemoMode: () => h.demo,
}))
vi.mock("../src/features/migration/runIntraRollupMigration", () => ({
  runIntraRollupMigration: h.migrate,
}))
vi.mock("../src/features/migration/migrationFee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/migration/migrationFee")>()),
  loadMigrationFee: h.fee,
}))

const { showReportableError } = await import("../src/errors/errorModal")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
const { walletStorage } = await import("../src/platform/storage/walletStorage")
const { getOperationStore, runOperation } = await import("../src/features/operations/operations")
const upsert = vi.spyOn(notes.store, "upsert")
const dismiss = vi.spyOn(notes.store, "dismiss")
const remove = vi.spyOn(notes.store, "remove")
const residualsRow = () => notes.store.get("migration:residuals")
/** Every write to the residuals row, so other rows' writes don't count. */
const residualsWrites = () =>
  [...upsert.mock.calls.map(([row]) => row.id), ...remove.mock.calls.map(([id]) => id)].filter(
    (id) => id === "migration:residuals",
  )
const { MigrationDetectionMount, PROFILE_REPOINT_POLL_MS } = await import(
  "../src/features/migration/MigrationDetectionMount"
)
const { openMigrationDialog, useUpgradeStatus } = await import(
  "../src/features/migration/migrationDialog"
)
const { markOldHoldingsRead, oldVersionScope, useOldVersionHoldings } = await import(
  "../src/features/migration/oldVersionBalance"
)
const { BalanceStorage } = await import("@obsidion/front-core")
const { acquireUpgradeLock, upgradeLock } = await import("../src/features/migration/upgradeLock")

const incomplete: HistoricResidualSummary = {
  tuple: { portal: "0x" + "01".repeat(20), l2Token: "0x" + "01".repeat(32) } as never,
  balance: 0n,
  frozen: false,
  sweptDeposits: 0,
  inTransitDeposits: 0,
  inTransitAmount: 0n,
  waitingDeposits: 0,
  waitingAmount: 0n,
  paylinkEscrows: 0,
  lockedPaylinks: [],
  paylinkCandidates: [],
  frozenLinks: [],
  incomplete: true,
  hasResiduals: true,
}

let container: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  h.railPending = undefined
  h.railReadFailed = false
  h.registrations = []
  h.demo = false
  h.deposit = undefined
  h.account.obsidionAccount = ACCOUNT
  walletStorage.removeItem("webwallet.upgradeLock/0xabc")
  walletStorage.removeItem("webwallet.version/0xabc")
  h.probe.mockResolvedValue(null)
  // 0.1 tip, 0.05 old-portal cut, 0.3 arrival fee.
  h.fee.mockResolvedValue({
    relayerTip: (10n ** 17n).toString(),
    fpcFundingCut: (5n * 10n ** 16n).toString(),
    arrivalFee: (3n * 10n ** 17n).toString(),
  })
  h.reconcile.mockResolvedValue(undefined)
  h.live.mockResolvedValue(BOOTED_PORTAL.toLowerCase())
  h.asset.current = { tokenService: undefined, loadAssets: async () => {} }
  client = new QueryClient()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
  vi.useRealTimers()
})

let upgradeStatus = () => ({}) as ReturnType<typeof useUpgradeStatus>
function Status() {
  const status = useUpgradeStatus()
  upgradeStatus = () => status
  return null
}

/** Mounts, then asks for the dialog as Home's banner does, unless `request` is false. */
async function render({ request = true } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MigrationDetectionMount />
        <Status />
      </QueryClientProvider>,
    )
  })
  if (request) await act(async () => openMigrationDialog())
}

async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROFILE_REPOINT_POLL_MS)
    await vi.advanceTimersByTimeAsync(50)
  })
}

const repointModal = () => container.querySelector('[data-testid="migration-repoint-modal"]')

const withTokenService = () => {
  h.asset.current = { tokenService: {}, loadAssets: async () => {} }
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label)
const retryButton = () => button("Try again")
const detectedModal = () => document.querySelector('[data-testid="migration-detected-modal"]')
/** Opens the deposit screen from the dialog, as "Deposit funds & upgrade" does. */
const depositToUpgrade = async () => {
  await act(async () => button("Deposit funds & upgrade")!.click())
  return () => h.deposit!.target!
}

describe("MigrationDetectionMount — metadata external funding", () => {
  it("funds the upgrade through the deposit screen at the update's fee, once its bootstrap is sent", async () => {
    withTokenService()
    const record = {
      plan: "signed-plan",
      phase: "awaitingMessages",
      bootstrapTx: "0x" + "b0".repeat(32),
      bootstrapStatus: "pending",
    }
    let snapshot: typeof record | null = null
    let publish = () => {}
    const controller = {
      load: async () => {},
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        publish = listener
        return () => {}
      },
    }
    const terms = {
      fee: 5n * 10n ** 17n,
      minimumAmount: 5n * 10n ** 17n + 1n,
      token: "0x" + "34".repeat(20),
      symbol: "DAI",
      decimals: 18,
    }
    h.metadataSession.mockResolvedValue({
      controller,
      service: {
        needsMigration: async () => true,
        fundingTerms: async () => terms,
        funding: async () => ({ ...terms, address: "0x" + "12".repeat(20), external: true }),
      },
    })
    h.runMetadata.mockImplementation(async (_controller, { onProgress }) => {
      snapshot = record
      publish()
      await onProgress?.()
      return record
    })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [],
      residuals: [],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()?.textContent).toContain("Deposit to keep your tag")
    expect(detectedModal()?.textContent).toContain("Deposit at least $1 and the upgrade runs")
    expect(detectedModal()?.textContent).not.toContain("Send at least")
    const target = await depositToUpgrade()
    expect(h.deposit?.title).toBe("Deposit to upgrade")
    expect(target()).toMatchObject({
      kind: "upgrade",
      address: undefined,
      fee: terms.fee,
      floor: terms.minimumAmount,
      ask: 10n ** 18n,
      creatingNote: "Just a moment, we're making your address private.",
    })
    expect(h.runMetadata).not.toHaveBeenCalled()
    await act(async () => target().create!())
    expect(target().address).toMatchObject({ address: "0x" + "12".repeat(20), publishing: true })
  })

  it("offers the deposit only once the figure its lock holds is known", async () => {
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        needsMigration: async () => true,
        fundingTerms: async () => ({
          fee: 5n * 10n ** 17n,
          minimumAmount: 5n * 10n ** 17n + 1n,
          token: "0x" + "34".repeat(20),
          symbol: "DAI",
          decimals: 18,
        }),
      },
    })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [],
      residuals: [],
      pendingWithdrawals: 0,
    })
    h.balance = { walletBalance: "0.00", balanceKnown: false }
    try {
      await render()
      expect(button("Deposit funds & upgrade")!.disabled).toBe(true)

      h.balance = { walletBalance: "0.00", balanceKnown: true }
      await render()
      expect(button("Deposit funds & upgrade")!.disabled).toBe(false)
    } finally {
      h.balance = { walletBalance: "0.00", balanceKnown: true }
    }
  })

  it("holds Main without the old version's dust, which the upgrade leaves behind", async () => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    markOldHoldingsRead("0xabc")
    h.balance = { walletBalance: "2.00", balanceKnown: true }
    const dust: HistoricResidualSummary = {
      ...incomplete,
      tuple: { ...incomplete.tuple, portal: "0x" + "03".repeat(20) } as never,
      frozen: true,
      incomplete: false,
      balance: 10n ** 17n,
    }
    await BalanceStorage.get(webStorage).updateBalance(
      oldVersionScope(dust.tuple.portal, "0xabc"),
      dust.tuple.l2Token,
      10n ** 17n,
    )
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 0n, stranded: 10n ** 17n, waiting: 0n }),
        needsMigration: async () => true,
        fundingTerms: async () => ({
          fee: 5n * 10n ** 17n,
          minimumAmount: 5n * 10n ** 17n + 1n,
          token: "0x" + "34".repeat(20),
          symbol: "DAI",
          decimals: 18,
        }),
      },
      holdings: async () => true,
    })
    h.runMetadata.mockImplementationOnce(async () => null)
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [dust.tuple],
      residuals: [dust],
      pendingWithdrawals: 0,
    })
    try {
      await render()
      const target = await depositToUpgrade()
      await act(async () => target().create!())

      expect(upgradeLock("0xabc")).toEqual({ state: "held", main: 2n * 10n ** 18n })
    } finally {
      h.balance = { walletBalance: "0.00", balanceKnown: true }
      walletStorage.removeItem("webwallet.identity")
      walletStorage.removeItem(`webwallet.oldHoldingsRead/${BOOTED_PORTAL.toLowerCase()}/0xabc`)
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(dust.tuple.portal, "0xabc"),
        dust.tuple.l2Token,
        0n,
      )
    }
  })
})

describe("MigrationDetectionMount — an externally funded run", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
  }
  const external = (over: Record<string, unknown> = {}) => ({
    phase: "awaitingMessages",
    plan: JSON.stringify({ sourceState: "empty" }),
    bootstrapTx: "0x" + "b0".repeat(32),
    ...over,
  })
  let snapshot: Record<string, unknown> | null
  let publish: () => void
  let restore = () => {}
  const saved = (record: Record<string, unknown> | null) => {
    const read = webStorage.getItem.bind(webStorage)
    const spy = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test" ? (record ? JSON.stringify(record) : null) : read(key),
      )
    restore = () => spy.mockRestore()
  }
  type RunOptions = {
    signal: AbortSignal
    promptless?: boolean
    observeOnly?: boolean
    until?: (record: unknown) => boolean
    exclusive?: <T>(step: (operationId?: string) => Promise<T>) => Promise<T>
    onProgress?: () => Promise<void>
  }
  const runs = () => h.runMetadata.mock.calls.map(([, opts]) => opts as RunOptions)
  const untilAborted = (signal: AbortSignal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(snapshot)))
  beforeEach(async () => {
    withTokenService()
    snapshot = null
    publish = () => {}
    await notes.store.remove("migration:run")
    h.metadataSession.mockResolvedValue({
      controller: {
        load: async () => publish(),
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          publish = listener
          return () => {}
        },
      },
      service: {
        needsMigration: async () => true,
        funding: async () => ({
          address: "0x" + "12".repeat(20),
          token: "0x" + "34".repeat(20),
          fee: 5n * 10n ** 17n,
          minimumAmount: 5n * 10n ** 17n + 1n,
          symbol: "DAI",
          decimals: 18,
          external: true,
        }),
      },
    })
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
  })
  afterEach(() => restore())

  it("carries a run left at boot to the end with no click and no prompt, each step in the background", async () => {
    snapshot = external()
    saved(snapshot)
    let step: unknown
    h.runMetadata.mockImplementationOnce(async (_c: unknown, opts: RunOptions) => {
      await opts.exclusive!(async (operationId) => {
        step = getOperationStore().get(operationId!)
      })
      return { ...snapshot, phase: "done" }
    })
    const loadAssets = vi.fn(async () => {})
    h.asset.current = { tokenService: {}, loadAssets }
    await render({ request: false })
    expect(runs()).toHaveLength(1)
    expect(runs()[0]).toMatchObject({ promptless: true })
    expect(runs()[0]!.observeOnly).toBeUndefined()
    expect(step).toMatchObject({ flow: "migration", state: "local", background: true })
    expect(loadAssets).toHaveBeenCalled()
    expect(notes.store.get("migration:run")).toBeNull()
  })

  it("shows the followed run's address on the deposit screen, and never starts it again", async () => {
    snapshot = external()
    saved(snapshot)
    h.runMetadata.mockImplementationOnce(async (_c: unknown, opts: RunOptions) => {
      await opts.onProgress?.()
      return untilAborted(opts.signal)
    })
    await render()
    expect(upgradeStatus()).toMatchObject({ state: "running", phase: "awaitingMessages" })
    expect(notes.store.get("migration:run")).toBeNull()
    const target = await depositToUpgrade()
    expect(target().address?.address).toBe("0x" + "12".repeat(20))
    await act(async () => target().create!())
    expect(runs()).toHaveLength(1)
  })

  // Its recovery may withdraw from the old version, which asks a passkey.
  it("leaves an old version's run to the user, even one prepared with nothing there", async () => {
    snapshot = external()
    saved(snapshot)
    const old = { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) }
    h.probe.mockResolvedValue({ current, historic: [old], residuals: [], pendingWithdrawals: 0 })
    await render({ request: false })
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(upgradeStatus().state).toBe("stopped")
  })

  it("reads a follower that failed as a failed check, never as a paused run", async () => {
    snapshot = external()
    saved(snapshot)
    h.runMetadata.mockRejectedValueOnce(new Error("session lost"))
    await render({ request: false })
    expect(upgradeStatus().state).toBe("failed")
  })

  it("never offers to start a run its follower is still opening", async () => {
    snapshot = external()
    saved(snapshot)
    h.metadataSession.mockImplementation(async () => ({
      controller: {
        load: () => new Promise(() => {}),
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      },
      service: { needsMigration: async () => true },
    }))
    await render()
    expect(button("Upgrade now")).toBeUndefined()
    const target = await depositToUpgrade()
    await act(async () => target().create!())
    expect(h.runMetadata).not.toHaveBeenCalled()
  })

  // The update's address takes one sweep: anything sent after it strands there.
  it("takes the address back, and leaves the deposit screen, once its deposit is swept", async () => {
    snapshot = external()
    saved(snapshot)
    h.runMetadata.mockImplementationOnce(async (_c: unknown, opts: RunOptions) => {
      await opts.onProgress?.()
      return untilAborted(opts.signal)
    })
    await render()
    const target = await depositToUpgrade()
    expect(target().address).toBeDefined()
    snapshot = external({ swept: true })
    await act(async () => publish())
    expect(document.querySelector('[data-testid="deposit-screen"]')).toBeNull()
    expect(target().address).toBeUndefined()
    expect(button("Deposit funds & upgrade")).toBeUndefined()
  })

  it("shows a stop over the deposit screen when the follower ends on one", async () => {
    snapshot = external()
    saved(snapshot)
    let stop!: (record: unknown) => void
    h.runMetadata.mockImplementationOnce(
      (_c: unknown, opts: RunOptions) =>
        new Promise((resolve) => {
          void opts.onProgress?.()
          stop = resolve
        }),
    )
    await render()
    await depositToUpgrade()
    expect(document.querySelector('[data-testid="deposit-screen"]')).not.toBeNull()
    const stopped = external({ phase: "needsApproval", error: "needs you" })
    await act(async () => {
      snapshot = stopped
      publish()
      stop(stopped)
    })
    expect(document.querySelector('[data-testid="deposit-screen"]')).toBeNull()
    expect(detectedModal()?.textContent).toContain("Your upgrade needs another approval")
  })

  it("leaves a run that stopped for the user to the user", async () => {
    snapshot = external({ phase: "needsApproval", error: "needs you" })
    saved(snapshot)
    await render({ request: false })
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(upgradeStatus().state).toBe("stopped")
  })

  it("hands the user's own start to the follower once its bootstrap is sent", async () => {
    saved(null)
    h.runMetadata
      .mockImplementationOnce(async (_c: unknown, opts: RunOptions) => {
        snapshot = external({ phase: "broadcasting" })
        publish()
        expect(opts.until?.(snapshot)).toBe(true)
        return snapshot
      })
      .mockImplementationOnce((_c: unknown, opts: RunOptions) => untilAborted(opts.signal))
    await render()
    const target = await depositToUpgrade()
    await act(async () => target().create!())
    expect(runs()).toHaveLength(2)
    expect(runs()[0]!.promptless).toBeUndefined()
    expect(runs()[1]).toMatchObject({ promptless: true })
    expect(upgradeStatus().state).toBe("running")
    expect(target().creating).toBe(false)
  })
})

describe("MigrationDetectionMount — frozen sources", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
  }
  const frozen = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary => ({
    ...incomplete,
    frozen: true,
    incomplete: false,
    ...over,
  })
  const session = (quote: Partial<MigrationSourceQuote>) =>
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 0n, stranded: 0n, waiting: 0n, ...quote }),
        needsMigration: async () => false,
      },
    })
  const probe = (residual: HistoricResidualSummary) =>
    h.probe.mockResolvedValue({
      current,
      historic: [residual.tuple],
      residuals: [residual],
      pendingWithdrawals: 0,
    })

  it("offers a source holding only deposits once its refunds can move them", async () => {
    withTokenService()
    session({ movable: 20n * 10n ** 18n })
    probe(frozen({ sweptDeposits: 2 }))
    await render()
    expect(detectedModal()?.textContent).not.toContain("Also there")
    expect(button("Upgrade now")).toBeDefined()
  })

  // Home's balances show what moves; the sheet shows what it costs (Figma 12709:36185).
  it("sums up what the upgrade pays and the approvals it asks for, not what it moves", async () => {
    withTokenService()
    session({ movable: 30n * 10n ** 18n, batches: 3, approvals: 4, fees: 15n * 10n ** 17n })
    probe(frozen({ balance: 10n * 10n ** 18n, sweptDeposits: 2 }))
    await render()
    const text = detectedModal()?.textContent
    expect(text).toContain("It takes about 40 minutes, and your balance stays safe.")
    expect(text).toContain("Costs $1.50 in network fees")
    expect(text).toContain("Approvals 4")
    for (const dropped of ["Amount", "Fees $", "You'll receive", "About an hour", "Keep this tab"])
      expect(text).not.toContain(dropped)
  })

  it("says why the fee is charged behind its pill, only on a press", async () => {
    withTokenService()
    session({ movable: 30n * 10n ** 18n, batches: 3, approvals: 4, fees: 15n * 10n ** 17n })
    probe(frozen({ balance: 10n * 10n ** 18n, sweptDeposits: 2 }))
    await render()
    const fee = document.querySelector<HTMLElement>('[data-testid="upgrade-fee"]')!
    const pill = fee.querySelector("button")!
    const tip = fee.querySelector('[role="tooltip"]')!
    expect(pill.getAttribute("aria-describedby")).toBe(tip.id)
    expect(tip.textContent).toBe(
      "Moving your funds onto the new network works as a deposit, and every deposit pays a small network fee that comes out of your balance.",
    )
    expect(fee.dataset.open).toBeUndefined()
    await act(async () => pill.click())
    expect(fee.dataset.open).toBeDefined()
    expect(pill.getAttribute("aria-expanded")).toBe("true")
  })

  // Its saved batches keep their selections, which the quote can't see.
  it("shows a resumed run what its start was quoted, not a fresh quote", async () => {
    withTokenService()
    session({ movable: 30n * 10n ** 18n, batches: 3, approvals: 4, fees: 15n * 10n ** 17n })
    probe(frozen({ balance: 10n * 10n ** 18n, sweptDeposits: 2 }))
    const record = { phase: "needsAttention", plan: "p", error: "x" }
    const read = webStorage.getItem.bind(webStorage)
    const saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test" ? JSON.stringify(record) : read(key),
      )
    try {
      await render()
      let text = detectedModal()?.textContent
      expect(text).not.toContain("network fees")
      expect(text).not.toContain("Approvals")
      act(() => root.unmount())
      root = createRoot(container)
      Object.assign(record, { summary: { fees: (2n * 10n ** 18n).toString(), approvals: 6 } })
      await render()
      text = detectedModal()?.textContent
      expect(text).toContain("Costs $2.00 in network fees")
      expect(text).toContain("Approvals 6")
    } finally {
      saved.mockRestore()
    }
  })

  it("adds the refunds a run takes to the notes, and names what no batch can afford", async () => {
    withTokenService()
    session({ movable: 30n * 10n ** 18n, stranded: 3n * 10n ** 17n })
    probe(frozen({ balance: 10n * 10n ** 18n, sweptDeposits: 2 }))
    await render()
    expect(detectedModal()?.textContent).toContain("Also there: $0.30 too small to move.")
    expect(residualsRow()).toMatchObject({ description: "$0.30 too small to move" })
  })

  it("names dust under a cent as such, never as nothing", async () => {
    withTokenService()
    session({ stranded: 1n })
    probe(frozen({ balance: 1n }))
    await render()
    expect(residualsRow()).toMatchObject({ description: "<$0.01 too small to move" })
  })

  it("names a balance no refund batch can afford instead of offering to move it", async () => {
    withTokenService()
    session({ stranded: 75n * 10n ** 16n })
    probe(frozen({ balance: 5n * 10n ** 17n, sweptDeposits: 1 }))
    await render()
    expect(detectedModal()).toBeNull()
    expect(residualsRow()).toMatchObject({ description: "$0.75 too small to move" })
  })

  it("names a frozen balance a destination without the metadata flow cannot take", async () => {
    withTokenService()
    h.probe.mockResolvedValue({
      current: { ...current, updateMetadataSIPAImplementation: undefined },
      historic: [incomplete.tuple],
      residuals: [frozen({ balance: 5n * 10n ** 17n })],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()).toBeNull()
    expect(h.metadataSession).not.toHaveBeenCalled()
    expect(residualsRow()).toMatchObject({ description: "$0.50 on a frozen version" })
  })

  it("names unprocessed deposits that wait for the old network to close their Inbox tree", async () => {
    withTokenService()
    session({})
    probe(frozen({ waitingDeposits: 2, waitingAmount: 20n * 10n ** 18n }))
    await render()
    expect(detectedModal()).toBeNull()
    expect(residualsRow()).toMatchObject({ description: "$20.00 waiting on the old network" })
  })

  describe("with a saved run on one of two sources", () => {
    const a = { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) }
    const b = { ...incomplete.tuple, portal: "0x" + "0b".repeat(20) }
    const DAI = 10n ** 18n
    let restore = () => {}
    afterEach(() => restore())
    /** `b`'s run is saved; `a` comes first among the residuals, so it would be the first movable. */
    async function resume(
      phase: string,
      quotes: { a: bigint; b: bigint },
      stranded: { a?: bigint; b?: bigint } = {},
    ) {
      withTokenService()
      const calls: Array<[string, boolean | undefined]> = []
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: {
          quote: async (opts: { firstBatchSettled?: boolean }) => {
            const which = historic.portal === a.portal ? "a" : "b"
            calls.push([which, opts.firstBatchSettled])
            return { movable: quotes[which] * DAI, stranded: stranded[which] ?? 0n, waiting: 0n }
          },
          needsMigration: async () => false,
        },
      }))
      const record = { plan: "signed-plan", phase }
      const read = webStorage.getItem.bind(webStorage)
      const saved = vi
        .spyOn(webStorage, "getItem")
        .mockImplementation(async (key) =>
          key === "migration-test" ? JSON.stringify(record) : read(key),
        )
      restore = () => saved.mockRestore()
      h.probe.mockResolvedValue({
        current,
        historic: [b, a],
        residuals: [
          frozen({ tuple: a as never, sweptDeposits: 1 }),
          frozen({ tuple: b as never, sweptDeposits: 1 }),
        ],
        pendingWithdrawals: 0,
      })
      await render()
      return { calls, record }
    }

    it("quotes the resumed source, past its first refund, and lists the other", async () => {
      const { calls } = await resume("recovering", { a: 30n, b: 50n })
      expect(detectedModal()?.textContent).toContain("Also there: $30.00 on another old version.")
      expect(calls).toContainEqual(["b", true])
      expect(calls.filter(([which]) => which === "a").every(([, settled]) => !settled)).toBe(true)
    })

    it("holds the first batch to its fee until the refund it carries has executed", async () => {
      const { calls } = await resume("awaitingMessages", { a: 30n, b: 50n })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every(([, settled]) => !settled)).toBe(true)
    })

    it("quotes again once a run stops, not from before it", async () => {
      const stranded: { b?: bigint } = {}
      const { record } = await resume("recovering", { a: 30n, b: 50n }, stranded)
      expect(detectedModal()?.textContent).not.toContain("too small to move")
      // The run's first refund executes before it stops, and leaves dust no batch affords.
      stranded.b = 3n * 10n ** 17n
      h.runMetadata.mockResolvedValue({ ...record, phase: "needsAttention", error: "x" })
      await act(async () => button("Continue upgrade")!.click())
      expect(detectedModal()?.textContent).toContain("$0.30 too small to move")
    })
  })

  it("takes a quoted source's waiting deposits from its quote", async () => {
    withTokenService()
    session({ movable: 40n * 10n ** 18n })
    probe(
      frozen({ balance: 30n * 10n ** 18n, waitingDeposits: 1, waitingAmount: 10n * 10n ** 18n }),
    )
    await render()
    expect(button("Upgrade now")).toBeDefined()
    expect(detectedModal()?.textContent).not.toContain("waiting")
  })

  it("reads a failed check as incomplete, never as nothing to move", async () => {
    withTokenService()
    h.metadataSession.mockRejectedValue(new Error("source node down"))
    probe(frozen({ sweptDeposits: 1 }))
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
  })
})

describe("MigrationDetectionMount — what is left on an old version", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
  }
  const movable = vi.fn(async () => false)
  beforeEach(() => {
    withTokenService()
    movable.mockResolvedValue(false)
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({
          movable: (await movable()) ? 10n ** 18n : 0n,
          stranded: 0n,
          waiting: 0n,
        }),
        needsMigration: async () => false,
      },
    })
  })
  const probe = (over: Partial<HistoricResidualSummary>) =>
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals: [{ ...incomplete, frozen: true, incomplete: false, ...over }],
      pendingWithdrawals: 0,
    })
  const remount = async () => {
    act(() => root.unmount())
    root = createRoot(container)
    await render()
  }
  const listModal = () => document.querySelector('[data-testid="migration-residuals-modal"]')

  it("lists what is left only on request, with why it can't move and a retry", async () => {
    probe({ waitingDeposits: 1, inTransitDeposits: 2 })
    await render({ request: false })
    expect(detectedModal()).toBeNull()
    expect(listModal()).toBeNull()
    await act(async () => openMigrationDialog())
    expect(listModal()?.textContent).toContain(
      "A deposit waiting: the old network must close its Inbox tree before it can move",
    )
    expect(listModal()?.textContent).toContain(
      "2 deposits in transit: the old network hasn't credited them yet",
    )
    await act(async () => button("Try again")!.click())
    expect(h.probe).toHaveBeenCalledTimes(2)
    await act(async () => button("Close")!.click())
    expect(listModal()).toBeNull()
  })

  it("lists payment links it could not judge against the chain clock", async () => {
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals: [
        { ...incomplete, incomplete: false, paylinkCandidates: [{ txHash: "0xlink" } as never] },
      ],
      pendingWithdrawals: 0,
      chainTimeUnknown: true,
    })
    await render()
    await act(async () => openMigrationDialog())
    expect(listModal()?.textContent).toContain(
      "Funds are still in a payment link on the old version",
    )
    expect(listModal()?.textContent).not.toContain("Nothing is left")
  })

  it("never says nothing is left while it is still checking what can move", async () => {
    movable.mockImplementation(() => new Promise(() => {}))
    probe({ balance: 10n ** 17n })
    await render()
    await act(async () => openMigrationDialog())
    expect(listModal()?.textContent).toContain("Still checking")
    expect(listModal()?.textContent).not.toContain("Nothing is left")
  })

  it("removes the row and offers Move funds once a waiting deposit can move", async () => {
    probe({ waitingDeposits: 1 })
    await render()
    expect(residualsRow()).toMatchObject({ description: "1 deposit(s) waiting on the old network" })
    movable.mockResolvedValue(true)
    probe({ sweptDeposits: 1 })
    await remount()
    expect(residualsRow()).toBeNull()
    expect(button("Upgrade now")).toBeDefined()
  })
})

describe("MigrationDetectionMount — registration with nothing to move", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
  }
  const live = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary => ({
    ...incomplete,
    incomplete: false,
    ...over,
  })
  const frozen = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary =>
    live({ frozen: true, ...over })
  const needsMigration = vi.fn(async () => true)
  const movable = vi.fn(async () => false)
  const sessionFor = vi.fn()
  let stranded = 0n
  beforeEach(() => {
    withTokenService()
    stranded = 0n
    needsMigration.mockResolvedValue(true)
    movable.mockResolvedValue(false)
    h.metadataSession.mockImplementation(async ({ historic }) => {
      sessionFor(historic.portal)
      return {
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: {
          quote: async () =>
            (await movable())
              ? { movable: 85n * 10n ** 18n, stranded: 0n, waiting: 0n }
              : { movable: 0n, stranded, waiting: 0n },
          needsMigration,
        },
      }
    })
  })
  const probe = (...residuals: HistoricResidualSummary[]) =>
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals,
      pendingWithdrawals: 0,
    })
  const registrationPrompt = () =>
    detectedModal()?.textContent?.includes("Deposit to keep your tag")
  let flag: () => boolean
  function Flag() {
    const { state, registration } = useUpgradeStatus()
    flag = () => registration && state === "offered"
    return null
  }
  async function renderWithFlag() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MigrationDetectionMount />
          <Flag />
        </QueryClientProvider>,
      )
    })
    await act(async () => openMigrationDialog())
  }

  it("asks for the registration update when the retired version holds nothing", async () => {
    probe()
    await renderWithFlag()
    expect(registrationPrompt()).toBe(true)
    expect(button("Deposit funds & upgrade")).toBeDefined()
    expect(sessionFor).toHaveBeenCalledWith(current.portal)
    expect(flag()).toBe(true)
  })

  it("asks for it when an old balance can't pay its own exit", async () => {
    stranded = 10n ** 17n
    probe(frozen({ balance: 10n ** 17n }))
    await render()
    expect(movable).toHaveBeenCalledTimes(1)
    expect(registrationPrompt()).toBe(true)
    expect(residualsRow()).toMatchObject({ description: "$0.10 too small to move" })
  })

  // The metadata flow moves only a frozen old version.
  it("asks for it over a live old version, which it neither reads nor moves", async () => {
    probe(live({ balance: 85n * 10n ** 18n }))
    await render()
    expect(movable).not.toHaveBeenCalled()
    expect(sessionFor).not.toHaveBeenCalledWith(incomplete.tuple.portal)
    expect(registrationPrompt()).toBe(true)
    expect(upgradeStatus()).toMatchObject({ state: "offered", registration: true })
    expect(residualsRow()).toMatchObject({ description: "$85.00 on another old version" })
  })

  it("leaves nothing to do over a live old version once the registration is current", async () => {
    needsMigration.mockResolvedValue(false)
    h.railPending = false
    probe(live({ balance: 85n * 10n ** 18n }))
    await render({ request: false })
    expect(movable).not.toHaveBeenCalled()
    expect(upgradeStatus().state).toBe("none")
  })

  it("never reads a failed probe or movability check as nothing to move", async () => {
    probe(incomplete)
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    probe(frozen({ balance: 10n ** 17n }))
    movable.mockRejectedValue(new Error("source node down"))
    await act(async () => retryButton()!.click())
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    expect(needsMigration).not.toHaveBeenCalled()
  })

  it("waits for a retry's own movability before asking", async () => {
    probe(incomplete, frozen({ balance: 10n ** 17n }))
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    let settle!: (movable: boolean) => void
    movable.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await act(async () => retryButton()!.click())
    expect(needsMigration).not.toHaveBeenCalled()
    expect(registrationPrompt()).toBeFalsy()
    await act(async () => settle(true))
    expect(detectedModal()?.textContent).toContain(
      "It takes about 40 minutes, and your balance stays safe.",
    )
  })

  it("asks once a retry completes the inventory", async () => {
    probe(incomplete)
    await render()
    expect(needsMigration).not.toHaveBeenCalled()
    probe()
    await act(async () => retryButton()!.click())
    expect(registrationPrompt()).toBe(true)
  })

  it("scans again when a run stops, rather than quoting over the scan before it", async () => {
    movable.mockResolvedValue(true)
    const transit = { inTransitDeposits: 1, inTransitAmount: 10n * 10n ** 18n }
    probe(frozen({ balance: 85n * 10n ** 18n, ...transit }))
    await render()
    expect(detectedModal()?.textContent).toContain("Also there: $10.00 in transit")
    // The deposit arrives before the run stops.
    probe(frozen({ balance: 95n * 10n ** 18n }))
    h.runMetadata.mockResolvedValue({ plan: "signed-plan", phase: "needsAttention", error: "x" })
    await act(async () => button("Upgrade now")!.click())
    expect(detectedModal()?.textContent).not.toContain("in transit")
  })

  it("moves a movable source rather than starting the registration-only session", async () => {
    movable.mockResolvedValue(true)
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    expect(detectedModal()?.textContent).toContain(
      "It takes about 40 minutes, and your balance stays safe.",
    )
    await act(async () => button("Upgrade now")!.click())
    expect(needsMigration).not.toHaveBeenCalled()
    expect(sessionFor).not.toHaveBeenCalledWith(current.portal)
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
  })

  it("reopens on request after Later", async () => {
    probe()
    await render()
    await act(async () => button("Maybe later")!.click())
    expect(detectedModal()).toBeNull()
    await act(async () => openMigrationDialog())
    expect(registrationPrompt()).toBe(true)
  })
})

describe("MigrationDetectionMount — metadata resume", () => {
  it("starts only on consent, ignores duplicate clicks and exposes a resumable service error", async () => {
    withTokenService()
    let snapshot = {
      plan: "signed-plan",
      phase: "awaitingMessages",
      error: undefined as string | undefined,
    }
    let publish = () => {}
    let finish!: () => void
    const controller = {
      load: async () => {},
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        publish = listener
        return () => {}
      },
    }
    h.metadataSession.mockResolvedValue({
      controller,
      service: { needsMigration: async () => true },
    })
    h.runMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          publish()
          finish = () => {
            snapshot = {
              ...snapshot,
              phase: "needsAttention",
              error: "Destination registry changed",
            }
            publish()
            resolve(snapshot)
          }
        }),
    )
    const current = {
      ...incomplete.tuple,
      updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
    }
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
    await render()
    expect(h.runMetadata).not.toHaveBeenCalled()
    const target = await depositToUpgrade()
    await act(async () => {
      target().create!()
      target().create!()
    })
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
    expect(h.runMetadata).toHaveBeenCalledWith(
      controller,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(target().creating).toBe(true)
    await act(async () => finish())
    // The stop is the dialog's to explain.
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Your upgrade couldn't finish a step. Continue to try again.",
    )
    const resume = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Continue upgrade",
    )!
    expect(resume.disabled).toBe(false)
    await act(async () => resume.click())
    expect(h.runMetadata).toHaveBeenCalledTimes(2)
    await act(async () => finish())
  })

  it("offers a saved migration on a fresh mount and runs it only on a click", async () => {
    withTokenService()
    const record = { plan: "signed-plan", phase: "awaitingMessages" }
    const read = webStorage.getItem.bind(webStorage)
    const saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test" ? JSON.stringify(record) : read(key),
      )
    try {
      const controller = {
        load: async () => {},
        getSnapshot: () => record,
        subscribe: () => () => {},
      }
      h.metadataSession.mockResolvedValue({
        controller,
        service: { needsMigration: async () => false },
      })
      h.runMetadata.mockResolvedValue(record)
      const current = {
        ...incomplete.tuple,
        updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
      }
      h.probe.mockResolvedValue({
        current,
        historic: [{ ...incomplete.tuple, portal: "0x" + "02".repeat(20) }],
        residuals: [],
        pendingWithdrawals: 0,
      })
      await render()
      expect(button("Continue upgrade")).toBeDefined()
      expect(h.runMetadata).not.toHaveBeenCalled()
      await act(async () => button("Continue upgrade")!.click())
      expect(h.runMetadata).toHaveBeenCalledTimes(1)
    } finally {
      saved.mockRestore()
    }
  })
})

describe("MigrationDetectionMount — an arriving upgrade", () => {
  const record = { plan: "signed-plan", phase: "arriving" }
  const source = { ...incomplete.tuple, portal: "0x" + "02".repeat(20) }
  let saved: { mockRestore(): void }
  beforeEach(() => {
    withTokenService()
    const read = webStorage.getItem.bind(webStorage)
    saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test" ? JSON.stringify(record) : read(key),
      )
    // Its refunds are published, not yet executed on L1: the source still quotes them.
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => record, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }),
        needsMigration: async () => false,
      },
    })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [
        { ...incomplete, tuple: source, frozen: true, incomplete: false, sweptDeposits: 2 },
      ],
      pendingWithdrawals: 0,
    })
  })
  afterEach(() => saved.mockRestore())

  it("is followed at boot without a prompt or a send, and opens no dialog", async () => {
    h.runMetadata.mockImplementation(() => new Promise(() => {}))
    await render({ request: false })
    expect(h.runMetadata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ observeOnly: true }),
    )
    expect(detectedModal()).toBeNull()
  })

  it("keeps a source followed while a replaced follower ends", async () => {
    let endFirst!: (record: unknown) => void
    h.runMetadata
      .mockImplementationOnce(() => new Promise((resolve) => (endFirst = resolve)))
      .mockImplementation(() => new Promise(() => {}))
    await render({ request: false })
    // A new token service restarts the boot's follower; the first one ends only after.
    h.asset.current = { tokenService: {}, loadAssets: async () => {} }
    await render({ request: false })
    await act(async () => endFirst({ ...record, phase: "arriving" }))
    expect(h.runMetadata.mock.calls.length).toBeGreaterThan(1)
    expect(detectedModal()).toBeNull()
  })

  it("lists what is left when the residuals row asks, while the run is followed", async () => {
    h.runMetadata.mockImplementation(() => new Promise(() => {}))
    await render({ request: false })
    await act(async () => openMigrationDialog("residuals"))
    expect(upgradeStatus().state).toBe("running")
    expect(document.querySelector('[data-testid="migration-residuals-modal"]')).not.toBeNull()
  })

  it("says on the banner, not in a dialog, when the followed run needs the user", async () => {
    h.runMetadata.mockResolvedValue({ ...record, phase: "needsApproval" })
    await render({ request: false })
    expect(detectedModal()).toBeNull()
    expect(upgradeStatus()).toMatchObject({ state: "stopped", phase: "needsApproval" })
  })

  it("reads a follower that fails as failed, and offers no new upgrade over it", async () => {
    h.runMetadata.mockImplementation(() => new Promise(() => {}))
    h.metadataSession.mockRejectedValue(new Error("source node down"))
    await render()
    expect(upgradeStatus().state).toBe("failed")
    expect(notes.store.get("migration:run")?.description).toBe(
      "We couldn't check your old funds. Open it to try again.",
    )
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    expect(button("Upgrade now")).toBeUndefined()
  })

  it("asks, once opened, to continue a run that needs the user", async () => {
    h.runMetadata.mockResolvedValue({ ...record, phase: "recovering" })
    await render()
    expect(button("Continue upgrade")).toBeDefined()
  })
})

describe("MigrationDetectionMount — the upgrade's run", () => {
  const source = { ...incomplete.tuple, portal: "0x" + "02".repeat(20) }
  type RunRecord = {
    phase: string
    plan?: string
    draft?: string
    error?: string
    refused?: boolean
    approvals?: { approved: number; total: number }
  }
  let snapshot: RunRecord | null
  let publish: () => void
  let quote: ReturnType<typeof vi.fn>
  let saved: { mockRestore(): void } | undefined
  const runRow = () => notes.store.get("migration:run")
  const operation = () =>
    getOperationStore()
      .list()
      .find((r) => r.flow === "migration")
  /** Runs until the mount aborts it, as on unmount. */
  const untilAborted = (signal: AbortSignal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(snapshot)))
  /** The run ends at `record`, after preparing when `prepared`; with no record it goes on. */
  const runTo = (record: RunRecord | null, prepared = true) =>
    h.runMetadata.mockImplementationOnce(
      async (_c: unknown, o: { onPrepared?: () => void; signal: AbortSignal }) => {
        if (prepared) o.onPrepared?.()
        if (!record) return untilAborted(o.signal)
        snapshot = record
        publish()
        return record
      },
    )
  const boot = (record: RunRecord) => {
    const read = webStorage.getItem.bind(webStorage)
    saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test" ? JSON.stringify(record) : read(key),
      )
  }
  beforeEach(async () => {
    withTokenService()
    snapshot = null
    publish = () => {}
    quote = vi.fn(async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }))
    await notes.store.remove("migration:run")
    for (const r of getOperationStore().list()) await getOperationStore().remove(r.operationId)
    h.metadataSession.mockResolvedValue({
      controller: {
        load: async () => {},
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          publish = listener
          return () => {}
        },
      },
      service: { quote, needsMigration: async () => false },
    })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [
        { ...incomplete, tuple: source, frozen: true, incomplete: false, sweptDeposits: 2 },
      ],
      pendingWithdrawals: 0,
    })
  })
  afterEach(() => {
    saved?.mockRestore()
    saved = undefined
  })
  const move = async () => {
    await render()
    await act(async () => button("Upgrade now")!.click())
  }

  it("asks to keep the tab open once a run starts, and saves what the start was quoted", async () => {
    quote.mockResolvedValue({
      movable: 20n * 10n ** 18n,
      stranded: 0n,
      waiting: 0n,
      batches: 2,
      approvals: 3,
      fees: 10n ** 18n,
    })
    const keep = "Keep this tab open until your funds are sent, usually a few minutes."
    runTo(null, false)
    await render()
    expect(detectedModal()?.textContent).not.toContain(keep)
    await act(async () => button("Upgrade now")!.click())
    expect(detectedModal()?.textContent).toContain(keep)
    expect(h.runMetadata.mock.calls[0]![1]).toMatchObject({
      summary: { fees: (10n ** 18n).toString(), approvals: 3 },
    })
  })

  it("stops asking to keep the tab open once every batch is sent", async () => {
    runTo({ phase: "arriving", plan: "p" })
    runTo(null, false)
    await move()
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Your funds are on their way")
    expect(detectedModal()?.textContent).not.toContain("Keep this tab open")
  })

  // The run saves `arriving` before its last pass ends, and the bell keeps the tab until it does.
  it("asks to keep the tab open at arriving while the run still holds it", async () => {
    let finish!: (record: RunRecord) => void
    h.runMetadata.mockImplementationOnce(async (_c: unknown, o: { onPrepared?: () => void }) => {
      o.onPrepared?.()
      snapshot = { phase: "arriving", plan: "p" }
      publish()
      return new Promise<RunRecord>((resolve) => (finish = resolve))
    })
    runTo(null, false)
    await move()
    await act(async () => openMigrationDialog())
    expect(operation()?.state).toBe("local")
    expect(detectedModal()?.textContent).toContain("Keep this tab open")
    await act(async () => finish({ phase: "arriving", plan: "p" }))
    expect(detectedModal()?.textContent).toContain("Your funds are on their way")
    expect(detectedModal()?.textContent).not.toContain("Keep this tab open")
  })

  it("continues a saved run on the quote its start saved", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x" })
    runTo(null, false)
    await render()
    await act(async () => button("Continue upgrade")!.click())
    expect(h.runMetadata.mock.calls[0]![1].summary).toBeUndefined()
  })

  it("holds the dialog through every approval, and a cancel sends nothing", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce((_c: unknown, o: { signal: AbortSignal }) => {
      signal = o.signal
      return untilAborted(o.signal)
    })
    await move()
    expect(detectedModal()?.textContent).toContain("Preparing transaction")
    expect(operation()?.state).toBe("local")
    await act(async () => button("Cancel")!.click())
    expect(signal.aborted).toBe(true)
    expect(operation()).toBeUndefined()
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("hands the run to the bell once everything is approved, and a close then keeps it", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce(
      (_c: unknown, o: { onPrepared(): void; signal: AbortSignal }) => {
        signal = o.signal
        o.onPrepared()
        return untilAborted(o.signal)
      },
    )
    await move()
    expect(detectedModal()).toBeNull()
    expect(operation()?.handedOffAt).toBeDefined()
    await act(async () => openMigrationDialog())
    await act(async () => button("Close")!.click())
    expect(signal.aborted).toBe(false)
  })

  it("settles once every batch is sent, then follows the rest without a prompt or a send", async () => {
    runTo({ phase: "arriving", plan: "p" })
    runTo(null)
    await move()
    expect(operation()?.state).toBe("settled")
    expect(h.runMetadata).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ observeOnly: true }),
    )
  })

  it("keeps a stop after the hand-off in the bell, until the run moves on", async () => {
    runTo({ phase: "needsAttention", plan: "p", error: "The relayer is down" })
    await move()
    expect(runRow()).toMatchObject({
      title: "Your upgrade needs you",
      severity: "error",
      target: { type: "migration.run" },
    })
    expect(showReportableError).not.toHaveBeenCalled()
    runTo(null, false)
    await act(async () => openMigrationDialog())
    await act(async () => button("Continue upgrade")!.click())
    expect(runRow()).toBeNull()
  })

  it("keeps a run the tab left mid-send in the bell at boot, with no prompt", async () => {
    boot({ phase: "recovering", plan: "p" })
    await render()
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(runRow()).toMatchObject({ description: "Your upgrade is paused. Open it to continue." })
  })

  it("continues a refused approval from where it stopped", async () => {
    boot({ phase: "needsAttention", draft: "d", approvals: { approved: 1, total: 6 } })
    await render()
    expect(button("Continue approving (2 of 6)")).toBeDefined()
  })

  it("asks for an approval the run is missing", async () => {
    boot({ phase: "needsApproval", plan: "p" })
    await render()
    expect(button("Approve and continue")).toBeDefined()
  })

  it("continues approvals a saved plan's refused prompt left", async () => {
    boot({ phase: "needsAttention", plan: "p", approvals: { approved: 1, total: 3 } })
    await render()
    expect(button("Continue approving (2 of 3)")).toBeDefined()
  })

  it("keeps a stop in the bell while the scan after it is still running", async () => {
    runTo({ phase: "needsAttention", plan: "p", error: "The relayer is down" })
    await render()
    h.probe.mockImplementation(() => new Promise(() => {}))
    await act(async () => button("Upgrade now")!.click())
    expect(runRow()).toMatchObject({ title: "Your upgrade needs you" })
  })

  it("shows a refused approval while the scan after it is still running", async () => {
    runTo(
      {
        phase: "needsAttention",
        error: "Not allowed",
        refused: true,
        approvals: { approved: 1, total: 6 },
      },
      false,
    )
    await render()
    h.probe.mockImplementation(() => new Promise(() => {}))
    await act(async () => button("Upgrade now")!.click())
    expect(detectedModal()?.textContent).toContain("The passkey request was closed")
    expect(button("Continue approving (2 of 6)")?.disabled).toBe(false)
  })

  it("hands a resumed frozen run to the bell once its old version holds nothing more", async () => {
    boot({ phase: "recovering", plan: JSON.stringify({ sourceState: "frozen" }) })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [],
      pendingWithdrawals: 0,
    })
    runTo(null)
    await render()
    await act(async () => button("Continue upgrade")!.click())
    expect(detectedModal()).toBeNull()
    expect(operation()?.handedOffAt).toBeDefined()
  })

  it("quotes only once the latest run's scan answers, when runs and their scans overlap", async () => {
    await render()
    const inventory = await h.probe.mock.results[0]!.value
    const scans: ((found: unknown) => void)[] = []
    h.probe.mockImplementation(() => new Promise((resolve) => scans.push(resolve)))
    runTo({ phase: "needsAttention", plan: "p", error: "first" }, false)
    await act(async () => button("Upgrade now")!.click())
    runTo({ phase: "needsAttention", plan: "p", error: "second" }, false)
    await act(async () => button("Continue upgrade")!.click())
    const quotes = quote.mock.calls.length
    await act(async () => scans[0]!(inventory))
    expect(quote.mock.calls.length).toBe(quotes)
    await act(async () => scans[1]!(inventory))
    expect(quote.mock.calls.length).toBeGreaterThan(quotes)
  })

  it("sums up a fresh run once an earlier one completed", async () => {
    quote.mockResolvedValue({
      movable: 20n * 10n ** 18n,
      stranded: 0n,
      waiting: 0n,
      batches: 2,
      approvals: 3,
      fees: 10n ** 18n,
    })
    runTo({ phase: "arriving", plan: "p" })
    runTo({ phase: "done", plan: "p" }, false)
    await move()
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Costs $1.00 in network fees")
    expect(detectedModal()?.textContent).toContain("Approvals 3")
  })

  it("offers the upgrade on Home only while no run is going", async () => {
    let offered = () => false
    function Offer() {
      const shown = useUpgradeStatus().state === "offered"
      offered = () => shown
      return null
    }
    h.runMetadata.mockImplementationOnce(
      (_c: unknown, o: { onPrepared(): void; signal: AbortSignal }) => {
        o.onPrepared()
        return untilAborted(o.signal)
      },
    )
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MigrationDetectionMount />
          <Offer />
        </QueryClientProvider>,
      )
    })
    await act(async () => openMigrationDialog())
    expect(offered()).toBe(true)
    await act(async () => button("Upgrade now")!.click())
    expect(offered()).toBe(false)
  })

  it("never asks a saved run to fund its own upgrade", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x" })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()?.textContent).toContain(
      "It takes about 40 minutes, and your balance stays safe.",
    )
    expect(detectedModal()?.textContent).not.toContain("fund the upgrade yourself")
  })

  it("says what stopped a run in the user's terms", async () => {
    boot({
      phase: "needsAttention",
      plan: "p",
      error: "Metadata state changed; prepare migration again",
    })
    await render()
    const alert = detectedModal()?.querySelector('[role="alert"]')?.textContent
    expect(alert).toBeDefined()
    expect(alert).not.toMatch(/migration|metadata/i)
  })

  // A live source is offered no more, but a run saved over one still resumes, inside the dialog. No
  // operation holds its tab, so the note asks to keep it until every batch is sent.
  it("resumes a run saved over a live source", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x" })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [{ ...incomplete, tuple: source, incomplete: false, balance: 20n * 10n ** 18n }],
      pendingWithdrawals: 0,
    })
    runTo(null, false)
    await render()
    await act(async () => button("Continue upgrade")!.click())
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
    expect(detectedModal()).not.toBeNull()
    expect(operation()).toBeUndefined()
    expect(detectedModal()?.textContent).toContain("Keep this tab open")
  })
})

describe("MigrationDetectionMount — the dialog opens only on request", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
  }
  const source: HistoricResidualSummary = {
    ...incomplete,
    frozen: true,
    incomplete: false,
    sweptDeposits: 2,
  }
  const needsMigration = vi.fn(async () => false)
  const runRow = () => notes.store.get("migration:run")
  beforeEach(async () => {
    withTokenService()
    needsMigration.mockReset().mockResolvedValue(false)
    await notes.store.remove("migration:run")
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }),
        needsMigration,
      },
    })
  })
  const probe = (...residuals: HistoricResidualSummary[]) =>
    h.probe.mockResolvedValue({
      current,
      historic: residuals.map((r) => r.tuple),
      residuals,
      pendingWithdrawals: 0,
    })

  it("offers a movable source on the banner, and opens it only when asked", async () => {
    probe(source)
    await render({ request: false })
    expect(detectedModal()).toBeNull()
    expect(upgradeStatus()).toEqual({ state: "offered", registration: true })
    await act(async () => openMigrationDialog())
    expect(button("Upgrade now")).toBeDefined()
  })

  it("titles the sheet for the action that asked for the upgrade", async () => {
    probe(source)
    await render({ request: false })
    await act(async () => openMigrationDialog({ action: "send" }))
    expect(detectedModal()?.textContent).toContain("Upgrade to send")
    expect(button("Upgrade now")).toBeDefined()
    await act(async () => button("Maybe later")!.click())
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Upgrade to a faster zk.money")
  })

  it("holds an action while the check runs, and starts it once nothing needs upgrading", async () => {
    h.railPending = false
    walletStorage.removeItem("webwallet.version/0xabc")
    let answer!: (found: unknown) => void
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await render({ request: false })
    const run = vi.fn()
    await act(async () => openMigrationDialog({ action: "withdraw", then: run }))
    expect(detectedModal()?.textContent).toContain("Upgrade to withdraw")
    expect(detectedModal()?.textContent).toContain("Checking whether your account needs to upgrade")
    expect(run).not.toHaveBeenCalled()
    expect(upgradeLock("0xabc").state === "released").toBe(false)
    await act(async () => answer({ current, historic: [], residuals: [], pendingWithdrawals: 0 }))
    expect(upgradeStatus().state).toBe("none")
    expect(run).toHaveBeenCalledOnce()
    expect(detectedModal()).toBeNull()
    // Nothing to upgrade here: later checks never hold this account's actions.
    expect(upgradeLock("0xabc").state === "released").toBe(true)
  })

  it("never reads the registration check as answered before it answers", async () => {
    h.railPending = false
    walletStorage.removeItem("webwallet.version/0xabc")
    let answer!: (found: unknown) => void
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    let needed!: (needed: boolean) => void
    needsMigration.mockReturnValue(new Promise((resolve) => (needed = resolve)))
    const states: string[] = []
    function History() {
      states.push(useUpgradeStatus().state)
      return null
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MigrationDetectionMount />
          <History />
        </QueryClientProvider>,
      )
    })
    const run = vi.fn()
    await act(async () => openMigrationDialog({ action: "send", then: run }))
    await act(async () => answer({ current, historic: [], residuals: [], pendingWithdrawals: 0 }))
    expect(states).not.toContain("none")
    expect(run).not.toHaveBeenCalled()
    expect(upgradeLock("0xabc").state === "released").toBe(false)
    await act(async () => needed(true))
    expect(states.at(-1)).toBe("offered")
    expect(run).not.toHaveBeenCalled()
  })

  it("offers the upgrade over an action held while the check runs", async () => {
    let answer!: (found: unknown) => void
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await render({ request: false })
    const run = vi.fn()
    await act(async () => openMigrationDialog({ action: "send", then: run }))
    await act(async () =>
      answer({ current, historic: [source.tuple], residuals: [source], pendingWithdrawals: 0 }),
    )
    expect(upgradeStatus().state).toBe("offered")
    expect(detectedModal()?.textContent).toContain("Upgrade to send")
    expect(button("Upgrade now")).toBeDefined()
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ["is still running", () => h.probe.mockReturnValue(new Promise(() => {}))],
    ["failed", () => h.probe.mockRejectedValueOnce(new Error("node unreachable"))],
  ])(
    "starts a held action for an account current here while the check %s, as a press now would",
    async (_, check) => {
      walletStorage.setItem("webwallet.version/0xabc", BOOTED_PORTAL.toLowerCase())
      check()
      await render({ request: false })
      const run = vi.fn()
      await act(async () => openMigrationDialog({ action: "send", then: run }))
      expect(run).toHaveBeenCalledOnce()
      expect(detectedModal()).toBeNull()
    },
  )

  it("offers a registration update with nothing to move, and opens it only when asked", async () => {
    needsMigration.mockResolvedValue(true)
    probe()
    await render({ request: false })
    expect(detectedModal()).toBeNull()
    expect(upgradeStatus().state).toBe("offered")
  })

  it("keeps a saved run that waits for the user on the banner and the bell, not in a dialog", async () => {
    const read = webStorage.getItem.bind(webStorage)
    const saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test"
          ? JSON.stringify({ phase: "needsApproval", plan: "p", allowance: "unknown" })
          : read(key),
      )
    try {
      probe(source)
      await render({ request: false })
      expect(detectedModal()).toBeNull()
      expect(upgradeStatus()).toEqual({
        state: "stopped",
        phase: "needsApproval",
        registration: true,
      })
      expect(runRow()?.title).toBe("Your upgrade needs you")
    } finally {
      saved.mockRestore()
    }
  })

  it("reads a failed scan as failed, with a retry on the bell, and opens nothing", async () => {
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals: [incomplete],
      pendingWithdrawals: 0,
    })
    await render({ request: false })
    expect(detectedModal()).toBeNull()
    expect(upgradeStatus().state).toBe("failed")
    expect(runRow()?.description).toBe("We couldn't check your old funds. Open it to try again.")
  })

  it("reads a failed boot check as failed, and trying again checks once more", async () => {
    h.probe.mockRejectedValueOnce(new Error("node unreachable"))
    await render({ request: false })
    expect(upgradeStatus().state).toBe("failed")
    expect(runRow()?.description).toBe("We couldn't check your old funds. Open it to try again.")
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    probe(source)
    await act(async () => retryButton()!.click())
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(upgradeStatus().state).toBe("offered")
    expect(runRow()).toBeNull()
  })

  it("holds every Try again while a retry's checks run", async () => {
    h.probe.mockRejectedValueOnce(new Error("node unreachable"))
    await render()
    let finish!: () => void
    h.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              current,
              historic: [source.tuple],
              residuals: [source],
              pendingWithdrawals: 0,
            })
        }),
    )
    await act(async () => retryButton()!.click())
    expect(retryButton()?.disabled ?? true).toBe(true)
    await act(async () => retryButton()?.click())
    expect(h.probe).toHaveBeenCalledTimes(2)
    await act(async () => finish())
    expect(upgradeStatus().state).toBe("offered")
  })

  it("reads a failed registration check as failed", async () => {
    needsMigration.mockRejectedValue(new Error("L1 unreachable"))
    probe()
    await render({ request: false })
    expect(upgradeStatus().state).toBe("failed")
  })

  it("offers nothing until the saved runs are read", async () => {
    const read = webStorage.getItem.bind(webStorage)
    const saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation((key) =>
        key === "migration-test" ? new Promise<string | null>(() => {}) : read(key),
      )
    try {
      probe(source)
      await render()
      expect(upgradeStatus().state).toBe("checking")
      expect(button("Upgrade now")).toBeUndefined()
    } finally {
      saved.mockRestore()
    }
  })

  it("runs each check once more on a retry", async () => {
    needsMigration.mockRejectedValueOnce(new Error("L1 unreachable"))
    h.probe.mockImplementation(async () => ({
      current: { ...current },
      historic: [],
      residuals: [],
      pendingWithdrawals: 0,
    }))
    await render()
    expect(upgradeStatus().state).toBe("failed")
    expect(needsMigration).toHaveBeenCalledTimes(1)
    await act(async () => retryButton()!.click())
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(needsMigration).toHaveBeenCalledTimes(2)
  })

  it("is never finishing for an account with no name", async () => {
    h.railPending = true
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    probe()
    await render({ request: false })
    expect(upgradeStatus()).toEqual({ state: "none", registration: false })
  })

  it("is finishing while the current registration waits to reach the rollup", async () => {
    h.railPending = true
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: "0xabc", handle: "taga", claimedAt: 0 }),
    )
    probe()
    await render()
    expect(upgradeStatus()).toEqual({ state: "finishing", registration: true })
    expect(detectedModal()?.textContent).toContain("Finish your upgrade")
    expect(button("Upgrade now")).toBeUndefined()
  })

  it("keeps checking, not finishing, while the readiness read fails", async () => {
    h.railPending = true
    h.railReadFailed = true
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: "0xabc", handle: "taga", claimedAt: 0 }),
    )
    h.account.obsidionAccount = { getAddress: () => ({ toString: () => "0xabc" }) }
    try {
      probe()
      await render({ request: false })
      expect(upgradeStatus()).toEqual({ state: "checking", registration: false })
    } finally {
      h.account.obsidionAccount = {}
    }
  })

  it("is nothing to do for an account this browser registered on this version", async () => {
    h.railPending = true
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: "0xabc", handle: "taga", claimedAt: 0 }),
    )
    h.registrations = [{ l2Address: "0xABC" }]
    probe()
    await render({ request: false })
    expect(upgradeStatus()).toEqual({ state: "none", registration: false })
  })
})

describe("MigrationDetectionMount — old-version holdings", () => {
  // Home keys old versions by the profile's portal, which the probe pins as current.
  const current = {
    ...incomplete.tuple,
    portal: BOOTED_PORTAL,
    updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
  }
  const funded: HistoricResidualSummary = {
    ...incomplete,
    tuple: { ...incomplete.tuple, portal: "0x" + "03".repeat(20) } as never,
    frozen: true,
    incomplete: false,
    balance: 10n ** 18n,
  }
  const drained = { ...incomplete.tuple, portal: "0x" + "04".repeat(20), l2Token: "0x04" }
  const holdings = vi.fn(async () => true)
  const quote = vi.fn(async () => ({ movable: 10n ** 18n, stranded: 0n, waiting: 0n }))
  const session = () =>
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: { quote, needsMigration: async () => false },
      holdings,
    })
  const recorded = (tuple: { portal: string; l2Token: string }) =>
    BalanceStorage.get(webStorage).getBalance(oldVersionScope(tuple.portal, "0xabc"), tuple.l2Token)
  let pending = () => false
  function Waiting() {
    const { pending: now } = useOldVersionHoldings()
    pending = () => now
    return null
  }
  async function renderWithHome() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MigrationDetectionMount />
          <Status />
          <Waiting />
        </QueryClientProvider>,
      )
    })
  }

  beforeEach(() => {
    holdings.mockClear()
    quote.mockClear()
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    walletStorage.removeItem(`webwallet.oldHoldingsRead/${BOOTED_PORTAL.toLowerCase()}/0xabc`)
  })

  it("reads what a source holds, and records nothing for one a complete scan found empty", async () => {
    withTokenService()
    session()
    h.probe.mockResolvedValue({
      current,
      historic: [funded.tuple, drained],
      residuals: [funded],
      pendingWithdrawals: 0,
    })

    await render({ request: false })

    expect(h.metadataSession).toHaveBeenCalledWith(
      expect.objectContaining({ historic: funded.tuple }),
    )
    expect(holdings).toHaveBeenCalledTimes(1)
    expect(await recorded(drained)).toBe(0n)
  })

  it("reads a source that holds only waiting deposits, without offering to move them", async () => {
    withTokenService()
    session()
    const waiting = { ...funded, balance: 0n, waitingDeposits: 1, waitingAmount: 5n }
    h.probe.mockResolvedValue({
      current,
      historic: [waiting.tuple],
      residuals: [waiting],
      pendingWithdrawals: 0,
    })

    await render({ request: false })

    expect(holdings).toHaveBeenCalledTimes(1)
    expect(quote).not.toHaveBeenCalled()
    expect(upgradeStatus().state).not.toBe("offered")
  })

  it("says the check failed when a source's holdings can't be read", async () => {
    withTokenService()
    session()
    holdings.mockResolvedValueOnce(false)
    const waiting = { ...funded, balance: 0n, waitingDeposits: 1, waitingAmount: 5n }
    h.probe.mockResolvedValue({
      current,
      historic: [waiting.tuple],
      residuals: [waiting],
      pendingWithdrawals: 0,
    })

    await render({ request: false })

    expect(upgradeStatus().state).toBe("failed")
  })

  it("says the check failed while a source's holdings are unread, even with an upgrade to offer", async () => {
    withTokenService()
    session()
    holdings.mockResolvedValueOnce(false)
    h.probe.mockResolvedValue({
      current,
      historic: [funded.tuple],
      residuals: [funded],
      pendingWithdrawals: 0,
    })

    await renderWithHome()

    expect(upgradeStatus().state).toBe("failed")
    expect(pending()).toBe(true)
  })

  it("keeps Home waiting until a check reads every old version, across checks", async () => {
    withTokenService()
    session()
    holdings.mockResolvedValueOnce(false)
    h.probe.mockResolvedValue({
      current,
      historic: [drained, funded.tuple],
      residuals: [funded],
      pendingWithdrawals: 0,
    })

    await renderWithHome()
    expect(await recorded(drained)).toBe(0n)
    expect(pending()).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    await renderWithHome()
    expect(pending()).toBe(false)
  })

  it("says the check failed when storage refuses a source's record", async () => {
    withTokenService()
    session()
    const write = vi.spyOn(webStorage, "setItem").mockRejectedValueOnce(new Error("QuotaExceeded"))
    h.probe.mockResolvedValue({
      current,
      historic: [drained],
      residuals: [],
      pendingWithdrawals: 0,
    })

    try {
      await renderWithHome()
    } finally {
      write.mockRestore()
    }

    expect(upgradeStatus().state).toBe("failed")
    expect(pending()).toBe(true)
  })

  it("has Home wait until every old version is read, not just the first recorded", async () => {
    withTokenService()
    session()
    let read = () => {}
    holdings.mockImplementationOnce(() => new Promise((resolve) => (read = () => resolve(true))))
    h.probe.mockResolvedValue({
      current,
      historic: [drained, funded.tuple],
      residuals: [funded],
      pendingWithdrawals: 0,
    })

    await renderWithHome()
    expect(await recorded(drained)).toBe(0n)
    await act(async () => {})
    expect(pending()).toBe(true)

    await act(async () => read())
    expect(pending()).toBe(false)
  })

  it("leaves what an incomplete scan could not read as it was", async () => {
    withTokenService()
    session()
    const unread = { ...incomplete, tuple: { ...incomplete.tuple, portal: "0x" + "05".repeat(20) } }
    h.probe.mockResolvedValue({
      current,
      historic: [unread.tuple],
      residuals: [unread],
      pendingWithdrawals: 0,
    })

    await render({ request: false })

    expect(holdings).not.toHaveBeenCalled()
    expect(await recorded(unread.tuple as never)).toBeUndefined()
  })

  it("has Home wait for the first read of old holdings with nothing recorded", async () => {
    withTokenService()
    session()
    let answer = (_: unknown) => {}
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))

    await renderWithHome()
    expect(pending()).toBe(true)

    await act(async () =>
      answer({ current, historic: [funded.tuple], residuals: [funded], pendingWithdrawals: 0 }),
    )
    expect(pending()).toBe(false)
  })

  // Its registration record names no deployment, so it can't vouch for this one's old versions.
  it("has Home wait for an account this browser registered until its first check", async () => {
    withTokenService()
    h.registrations = [{ l2Address: "0xABC" }]
    h.probe.mockReturnValue(new Promise(() => {}))

    await renderWithHome()

    expect(pending()).toBe(true)
  })

  it("never has Home wait in the demo, which has nothing to check", async () => {
    h.demo = true
    h.account.obsidionAccount = undefined

    await renderWithHome()

    expect(pending()).toBe(false)
  })
})

describe("MigrationDetectionMount — incomplete probe", () => {
  it("shows Retry and runs one probe for two immediate clicks", async () => {
    withTokenService()
    h.probe.mockResolvedValue({
      current: incomplete.tuple,
      residuals: [incomplete],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    expect(h.probe).toHaveBeenCalledTimes(1)

    let finish!: () => void
    h.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ current: incomplete.tuple, residuals: [], pendingWithdrawals: 0 })
        }),
    )
    await act(async () => {
      retryButton()!.click()
    })
    expect(retryButton()!.disabled).toBe(true)
    await act(async () => {
      retryButton()!.click()
    })
    expect(h.probe).toHaveBeenCalledTimes(2)
    await act(async () => finish())
    expect(detectedModal()).toBeNull()
  })
})

const withBalance: HistoricResidualSummary = {
  ...incomplete,
  balance: 85n * 10n ** 18n,
  inTransitDeposits: 1,
  waitingDeposits: 0,
  incomplete: false,
}

describe("MigrationDetectionMount — moving funds", () => {
  beforeEach(() => {
    withTokenService()
    h.probe.mockResolvedValue({
      current: { portal: "0x" + "02".repeat(20) } as never,
      residuals: [withBalance],
      pendingWithdrawals: 0,
    })
  })

  it("asks to move the balance, names the rest, and lets the user decide later", async () => {
    await render()
    expect(detectedModal()?.textContent).toContain("Your balance stays safe.")
    expect(detectedModal()?.textContent).toContain("About an hour, hands-off")
    expect(detectedModal()?.textContent).toContain("$85.00")
    expect(detectedModal()?.textContent).toContain("1 deposit(s) in transit")
    await act(async () => button("Maybe later")!.click())
    expect(detectedModal()).toBeNull()
  })

  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)))

  it("prices the move per deployment and names what the new balance receives", async () => {
    await render()
    await settle()
    const text = detectedModal()?.textContent
    expect(text).toContain("Old version fee ~$0.15")
    expect(text).toContain("New version fee ~$0.30")
    expect(text).toContain("You'll receive ~$84.55")
  })

  it("shows the fee loading, and no fee at all when it could not be read", async () => {
    h.fee.mockReturnValueOnce(new Promise(() => {}))
    await render()
    await settle()
    expect(detectedModal()?.textContent).toContain("You'll receive …")
    act(() => root.unmount())
    root = createRoot(container)
    client = new QueryClient()

    h.fee.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    await settle()
    expect(detectedModal()?.textContent).not.toContain("fee")
    expect(detectedModal()?.textContent).not.toContain("You'll receive")
    expect(button("Upgrade now")?.disabled).toBe(false)
  })

  it("shows the working beat until the passkey signs, then closes as the burn runs", async () => {
    let finish!: (record: unknown) => void
    h.migrate.mockImplementation(
      asOperation(() => new Promise((resolve) => (finish = resolve)), "migration"),
    )
    await render()
    await act(async () => button("Upgrade now")!.click())
    // Before the passkey the modal says what it is doing, not a disabled button.
    expect(detectedModal()?.textContent).toContain("Preparing transaction…")
    await act(async () => provingProgress.emitSigningStart())
    expect(detectedModal()?.textContent).toContain("Confirm with passkey…")
    expect(h.migrate).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "$85.00 to the new version" }),
    )

    await endSigningAndHandOff()
    expect(detectedModal()).toBeNull()

    h.probe.mockResolvedValue({ current: withBalance.tuple, residuals: [], pendingWithdrawals: 1 })
    await act(async () => finish({ localId: "w1" }))
  })

  it("labels the wait with the arrival's publish while it runs before the burn", async () => {
    let published!: () => void
    let finish!: (record: unknown) => void
    h.migrate.mockImplementation(
      asOperation(async () => {
        const root = getOperationStore()
          .list()
          .find((r) => r.flow === "migration" && r.state === "local")!
        await runOperation(
          {
            operationId: "op-arrival",
            flow: "migration-arrival",
            summary: "$25",
            parent: root.operationId,
          },
          () => new Promise<void>((resolve) => (published = resolve)),
        )
        return new Promise((resolve) => (finish = resolve))
      }, "migration"),
    )
    await render()
    await act(async () => button("Upgrade now")!.click())
    expect(detectedModal()?.textContent).toContain("Publishing your new address")
    await act(async () => published())
    expect(detectedModal()?.textContent).toContain("Preparing transaction…")
    await act(async () => finish({ localId: "w1" }))
  })

  it("reports a failure on the prompt, but not a closed passkey prompt", async () => {
    h.migrate.mockRejectedValueOnce(new Error("fee floor moved"))
    await render()
    await act(async () => button("Upgrade now")!.click())
    expect(showReportableError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fee floor moved" }),
      "migration:intra-rollup",
    )
    expect(button("Upgrade now")).toBeDefined()

    vi.mocked(showReportableError).mockClear()
    h.migrate.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }))
    await act(async () => button("Upgrade now")!.click())
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("leaves a failure after the hand-off to the record's rows", async () => {
    let fail!: (err: Error) => void
    h.migrate.mockImplementation(
      asOperation(() => new Promise((_, reject) => (fail = reject)), "migration"),
    )
    await render()
    await act(async () => button("Upgrade now")!.click())
    await endSigningAndHandOff()
    expect(detectedModal()).toBeNull()
    await act(async () => fail(new Error("burn reverted")))
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("turns residuals with nothing to do into a notification, not a modal", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [{ ...withBalance, balance: 0n }],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()).toBeNull()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "migration:residuals",
        description: "1 deposit(s) in transit",
        target: { type: "migration.residuals" },
      }),
    )
    expect(dismiss).not.toHaveBeenCalled()
  })

  it("removes the residuals row once a complete scan finds nothing left", async () => {
    h.probe.mockResolvedValue({ current: withBalance.tuple, residuals: [], pendingWithdrawals: 0 })
    await render()
    expect(remove).toHaveBeenCalledWith("migration:residuals")
    expect(upsert).not.toHaveBeenCalled()
  })

  it("never lists a live balance's own deposits beside it", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [{ ...withBalance, sweptDeposits: 1 }],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()?.textContent).toContain("$85.00")
    expect(detectedModal()?.textContent).not.toContain("unclaimed")
  })

  it("lists a live source's swept deposits when it has no balance that could hold them", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [{ ...withBalance, balance: 0n, inTransitDeposits: 0, sweptDeposits: 1 }],
      pendingWithdrawals: 0,
    })
    await render()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ description: "1 unclaimed deposit(s)" }),
    )
    expect(remove).not.toHaveBeenCalledWith("migration:residuals")
  })

  it("lists only what can't move beside a movable balance", async () => {
    await notes.store.remove("migration:residuals")
    await render()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ description: "1 deposit(s) in transit" }),
    )
  })

  it("keeps the residuals row while the wallet is locked, which reads nothing", async () => {
    await notes.store.upsert({
      id: "migration:residuals",
      sourceId: "migration:residuals",
      producer: "migration",
      domain: "migration",
      title: "Funds on an old version",
      description: "1 deposit(s) in transit",
      timestampMs: Date.now(),
      systemIcon: "clock.arrow.circlepath",
      severity: "info",
      target: { type: "migration.residuals" },
    })
    vi.clearAllMocks()
    h.probe.mockResolvedValue(null)
    await render()
    expect(remove).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
    expect(residualsRow()).toMatchObject({ description: "1 deposit(s) in transit" })
    expect(residualsRow()?.dismissedAt).toBeUndefined()
  })

  it("keeps the residuals row while paylinks could not be judged against the chain clock", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [],
      pendingWithdrawals: 0,
      chainTimeUnknown: true,
    })
    await render()
    expect(remove).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("keeps a dismissed residuals row dismissed across scans, until its notes change", async () => {
    const inTransit = (n: number) => ({
      current: withBalance.tuple,
      residuals: [{ ...withBalance, balance: 0n, inTransitDeposits: n }],
      pendingWithdrawals: 0,
    })
    const remount = async () => {
      vi.setSystemTime(Date.now() + 60_000)
      act(() => root.unmount())
      root = createRoot(container)
      await render()
    }
    h.probe.mockResolvedValue(inTransit(2))
    await render()
    expect(residualsRow()).toMatchObject({ description: "2 deposit(s) in transit" })
    await notes.store.dismiss("migration:residuals")

    await remount()
    expect(residualsRow()?.dismissedAt).toBeDefined()

    h.probe.mockResolvedValue(inTransit(3))
    await remount()
    expect(residualsRow()).toMatchObject({ description: "3 deposit(s) in transit" })
    expect(residualsRow()?.dismissedAt).toBeUndefined()
  })

  it("keeps the residuals row while the scan is incomplete", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [incomplete],
      pendingWithdrawals: 0,
    })
    await render()
    expect(residualsWrites()).toEqual([])
  })
})

describe("MigrationDetectionMount — one L1 scan per mount", () => {
  it("scans once without a spent check; reconciles at mount and again after the scan", async () => {
    withTokenService()
    await render()
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.probe.mock.calls[0]).toHaveLength(2)
    expect(h.reconcile).toHaveBeenCalledTimes(2)
    expect(h.reconcile.mock.calls.every(([, spent]) => typeof spent === "function")).toBe(true)
  })

  it("does not rescan when the token service resolves after mount; it reconciles with the spent check", async () => {
    await render()
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.reconcile).toHaveBeenCalledTimes(2)
    expect(h.reconcile.mock.calls.every(([, spent]) => spent === undefined)).toBe(true)
    withTokenService()
    await render()
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.reconcile).toHaveBeenCalledTimes(3)
    expect(h.reconcile.mock.calls[2]![1]).toBeTypeOf("function")
  })

  it("reconciles with the spent check again after a scan that was in flight when it arrived", async () => {
    let finishScan!: () => void
    h.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishScan = () => resolve(null)
        }),
    )
    await render()
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    withTokenService()
    await render()
    expect(h.reconcile).toHaveBeenCalledTimes(2)
    await act(async () => {
      finishScan()
    })
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.reconcile).toHaveBeenCalledTimes(3)
    expect(h.reconcile.mock.calls[2]![1]).toBeTypeOf("function")
  })

  it("does not advance the reconcile revision when a retry fails before recording", async () => {
    withTokenService()
    h.probe.mockResolvedValue({
      current: incomplete.tuple,
      residuals: [incomplete],
      pendingWithdrawals: 0,
    })
    await render()
    expect(h.reconcile).toHaveBeenCalledTimes(2)
    h.probe.mockRejectedValue(new Error("node down"))
    await act(async () => {
      retryButton()!.click()
    })
    expect(h.reconcile).toHaveBeenCalledTimes(2)
  })
})

describe("MigrationDetectionMount — profile repoint", () => {
  it("does not poll at mount and shows nothing while the live portal matches, case aside", async () => {
    await render()
    expect(h.live).not.toHaveBeenCalled()
    await poll()
    await poll()
    expect(h.live).toHaveBeenCalledTimes(2)
    expect(repointModal()).toBeNull()
  })

  it("prompts to reload on the first successful poll that pins another portal", async () => {
    h.live.mockResolvedValueOnce(BOOTED_PORTAL).mockResolvedValue("0x" + "bb".repeat(20))
    await render()
    await poll()
    expect(repointModal()).toBeNull()
    await poll()
    expect(repointModal()?.textContent).toContain("Reload")
  })

  it("never prompts on a document the boot policy rejects, and prompts on the next good poll", async () => {
    h.live.mockRejectedValueOnce(new Error('identifies as "other"'))
    h.live.mockRejectedValueOnce(new Error('identifies as "other"'))
    h.live.mockResolvedValue("0x" + "bb".repeat(20))
    await render()
    await poll()
    await poll()
    expect(h.live).toHaveBeenCalledTimes(2)
    expect(repointModal()).toBeNull()
    await poll()
    expect(repointModal()?.textContent).toContain("Reload")
  })

  it("holds the prompt while its Reload would lose a running proof", async () => {
    h.live.mockResolvedValue("0x" + "bb".repeat(20))
    const end = await startTabBoundOperation()
    await render()
    await poll()
    expect(repointModal()).toBeNull()
    await act(async () => end())
    expect(repointModal()?.textContent).toContain("Reload")
  })

  it("Later hides the prompt for the session", async () => {
    h.live.mockResolvedValue("0x" + "bb".repeat(20))
    await render()
    await poll()
    const later = [...container.querySelectorAll("button")].find((b) => b.textContent === "Later")
    await act(async () => {
      later!.click()
    })
    expect(repointModal()).toBeNull()
  })
})

describe("MigrationDetectionMount — the upgrade lock", () => {
  const current = {
    ...incomplete.tuple,
    portal: BOOTED_PORTAL,
    updateMetadataSIPAImplementation: "0x" + "56".repeat(20),
  }
  const source: HistoricResidualSummary = {
    ...incomplete,
    tuple: { ...incomplete.tuple, portal: "0x" + "03".repeat(20) } as never,
    frozen: true,
    incomplete: false,
    sweptDeposits: 2,
  }
  let needed: Promise<boolean>
  const session = () =>
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }),
        needsMigration: () => needed,
      },
      holdings: async () => true,
    })
  const nothingLeft = () =>
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
  const lock = () => upgradeLock("0xabc")
  const run = `metadata-migration/${BOOTED_PORTAL.toLowerCase()}/${"0x" + "03".repeat(20)}/0xabc`

  beforeEach(() => {
    needed = Promise.resolve(false)
    h.railPending = false
  })
  afterEach(async () => {
    h.balance = { walletBalance: "0.00", balanceKnown: true }
    await webStorage.removeItem("metadata-migration/runs")
    await webStorage.removeItem(run)
  })

  it("holds Main at what will land, before the run sends anything", async () => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    markOldHoldingsRead("0xabc")
    h.balance = { walletBalance: "2.00", balanceKnown: true }
    await BalanceStorage.get(webStorage).updateBalance(
      oldVersionScope(source.tuple.portal, "0xabc"),
      source.tuple.l2Token,
      205n * 10n ** 17n,
    )
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({
          movable: 20n * 10n ** 18n,
          stranded: 3n * 10n ** 17n,
          waiting: 2n * 10n ** 17n,
          batches: 2,
          approvals: 2,
          fees: 15n * 10n ** 17n,
        }),
        needsMigration: () => needed,
      },
      holdings: async () => true,
    })
    h.probe.mockResolvedValue({
      current,
      historic: [source.tuple],
      residuals: [source],
      pendingWithdrawals: 0,
    })
    let atStart: unknown
    h.runMetadata.mockImplementation(async () => {
      atStart = lock()
      return null
    })
    await render()
    await act(async () => button("Upgrade now")!.click())

    // $2 live and $20.50 on the old version, less $1.50 in fees, $0.30 too small to move and $0.20
    // still waiting on the old network.
    expect(atStart).toEqual({ state: "held", main: 205n * 10n ** 17n })
  })

  it("starts only once the figure it holds is known", async () => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    markOldHoldingsRead("0xabc")
    h.balance = { walletBalance: "0.00", balanceKnown: false }
    withTokenService()
    session()
    h.probe.mockResolvedValue({
      current,
      historic: [source.tuple],
      residuals: [source],
      pendingWithdrawals: 0,
    })
    h.runMetadata.mockImplementation(async () => null)
    await render()
    await act(async () => button("Upgrade now")!.click())
    expect(button("Upgrade now")!.disabled).toBe(true)
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(lock()).toEqual({ state: "pending" })

    h.balance = { walletBalance: "2.00", balanceKnown: true }
    await render()
    await act(async () => button("Upgrade now")!.click())
    expect(lock()).toEqual({ state: "held", main: expect.any(BigInt) })
  })

  it("opens and marks the account current once nothing is left to upgrade", async () => {
    await acquireUpgradeLock("0xabc", 7n)
    withTokenService()
    session()
    nothingLeft()
    await render({ request: false })

    expect(upgradeStatus().state).toBe("none")
    expect(lock()).toEqual({ state: "released" })
  })

  it("tries a release that failed to save again", async () => {
    await acquireUpgradeLock("0xabc", 7n)
    withTokenService()
    session()
    nothingLeft()
    vi.spyOn(walletStorage, "commitTransaction").mockRejectedValueOnce(new Error("disk full"))
    await render({ request: false })
    expect(lock().state).toBe("held")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(lock()).toEqual({ state: "released" })
  })

  it("stays held while a probe reads nothing, as on a sign-out mid-check", async () => {
    await acquireUpgradeLock("0xabc", 7n)
    await render({ request: false })

    expect(upgradeStatus().state).toBe("checking")
    expect(lock()).toEqual({ state: "held", main: 7n })
  })

  it("stays held until this inventory's registration check answers", async () => {
    await acquireUpgradeLock("0xabc", 7n)
    withTokenService()
    let answer!: (needed: boolean) => void
    needed = new Promise((resolve) => (answer = resolve))
    session()
    nothingLeft()
    await render({ request: false })
    expect(lock().state).toBe("held")

    await act(async () => answer(false))
    expect(lock().state).toBe("released")
  })

  it("leaves old versions out of Home once the lock is taken, and after it opens", async () => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    await BalanceStorage.get(webStorage).updateBalance(
      oldVersionScope(source.tuple.portal, "0xabc"),
      source.tuple.l2Token,
      5n,
    )
    let total = () => -1n
    function Holdings() {
      const held = useOldVersionHoldings().total
      total = () => held
      return null
    }
    const show = () => act(async () => root.render(<Holdings />))
    await show()
    expect(total()).toBe(5n)

    await acquireUpgradeLock("0xabc", 7n)
    await show()
    expect(total()).toBe(0n)

    const { releaseUpgradeLock } = await import("../src/features/migration/upgradeLock")
    await releaseUpgradeLock("0xabc")
    await show()
    expect(total()).toBe(0n)
  })

  it("is taken, with no figure, for a run an older build left unfinished", async () => {
    await webStorage.setItem("metadata-migration/runs", JSON.stringify([run]))
    await webStorage.setItem(run, JSON.stringify({ phase: "arriving" }))
    await render({ request: false })

    expect(lock()).toEqual({ state: "held", main: undefined })
  })
})
