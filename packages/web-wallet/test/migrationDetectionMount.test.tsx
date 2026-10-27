import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HistoricResidualSummary } from "../src/features/migration/historicResiduals"
import type { MigrationSourceQuote } from "@obsidion/sdk"
import { provingProgress } from "@obsidion/proving-progress"
import { asOperation, endSigningAndHandOff } from "./support/handOff"
import { startTabBoundOperation } from "./support/operations"

const BOOTED_PORTAL = "0x" + "AA".repeat(20)
const ACCOUNT = { getAddress: () => ({ toString: () => "0xabc" }) }

const h = vi.hoisted(() => ({
  networkReady: true,
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
  savings: { position: null as { value: bigint } | null },
  registrations: [] as { l2Address: string }[],
  demo: false,
  tokenCreate: vi.fn(),
  featureListed: vi.fn(async () => false),
  recordStale: vi.fn(),
  event: vi.fn(),
  /** A saved run's storage key by source portal; one key for every source when absent. */
  keyFor: undefined as undefined | ((portal: string) => string),
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
    useSavingsPosition: () => h.savings,
    useContractServiceContext: () => h.contracts,
    bootPriority: { whenReady: async () => {} },
    checkSpentViaPaylinkService: () => async () => new Map(),
    AppNotificationStore: { get: () => notes.store },
    runMetadataMigration: h.runMetadata,
    readSavingsVault: async () => "0x" + "0e".repeat(20),
    // One sUSDS is worth 1.2 DAI.
    readSavingsPrice: async () => ({ sharePrice: 12n * 10n ** 17n }),
  }
})
// The DS drags in liquid-glass optics jsdom can't render; these tests are about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
    testId,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
    testId?: string
  }) => (
    <button disabled={isDisabled} onClick={onClick} data-testid={testId}>
      {title}
    </button>
  ),
  DestructiveActionButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TopNavIconButton: () => null,
  Icon: () => null,
  GradientSpinner: () => null,
  ProgressSpinner: () => null,
  Shimmer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label} {value}
    </div>
  ),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {},
  TokenService: { create: h.tokenCreate },
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/features/cutover/networkReady", () => ({ useNetworkReady: () => h.networkReady }))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { portal: "0x" + "AA".repeat(20) } }),
  fetchLiveProfilePortal: h.live,
}))
vi.mock("../src/features/migration/probeAccountResiduals", () => ({
  probeAccountResiduals: h.probe,
  reconcilePendingPaylinks: h.reconcile,
  migrationFeatureListed: h.featureListed,
}))
vi.mock("../src/features/migration/createWebMetadataMigration", () => {
  const create = async (...args: unknown[]) => ({
    holdings: async () => true,
    ...(await h.metadataSession(...args)),
  })
  return {
    createWebMetadataMigration: create,
    // As the real one: a manifest that can't be read is read again, with each failure reported.
    createWebMetadataMigrationQuietly: async (
      params: unknown,
      signal: AbortSignal,
      _retryMs?: number,
      onUnavailable?: () => void,
    ) => {
      for (;;) {
        try {
          return await create(params)
        } catch (error) {
          if ((error as Error).name !== "ManifestUnavailableError" || signal.aborted) throw error
          onUnavailable?.()
          await new Promise((resolve) => setTimeout(resolve, 60_000))
        }
      }
    },
    webAccountRecordStale: () => h.recordStale(),
    webMetadataMigrationKey: (current: { portal: string }, historic: { portal: string }) =>
      h.keyFor?.(historic.portal) ??
      (historic.portal.toLowerCase() === current.portal.toLowerCase()
        ? "migration-registration"
        : "migration-test"),
  }
})
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
const freeze = vi.hoisted(() => ({ onFrozen: () => {} }))
vi.mock("../src/features/migration/freezeWatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/migration/freezeWatch")>()),
  watchForFreeze: (_tuples: unknown, onFrozen: () => void) => {
    freeze.onFrozen = onFrozen
    return () => {}
  },
}))
vi.mock("../src/features/migration/migrationFee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/migration/migrationFee")>()),
  loadMigrationFee: h.fee,
}))
vi.mock("../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analytics")>()),
  fireEvent: h.event,
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
const { UpgradeKeepOpenBanner } = await import("../src/features/migration/UpgradeIntro")
const { markOldHoldingsRead, markUpgradeMovesFunds, oldVersionScope, useOldVersionHoldings } =
  await import("../src/features/migration/oldVersionBalance")
const { RECORD_CHECK_WAIT_MS } = await import("../src/features/migration/upgradeFirst")
const { BalanceStorage } = await import("@obsidion/front-core")
const { ManifestUnavailableError } = await import("../src/features/migration/freezeWatch")
const { acquireUpgradeLock, upgradeLock } = await import("../src/features/migration/upgradeLock")
const { resetApprovals } = await import("../src/features/migration/approvalGate")

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
  awaitingFreeze: false,
}

let container: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  h.networkReady = true
  h.railPending = undefined
  h.railReadFailed = false
  h.registrations = []
  h.demo = false
  h.keyFor = undefined
  h.savings = { position: null }
  h.account.obsidionAccount = ACCOUNT
  walletStorage.removeItem("webwallet.upgradeLock/0xabc")
  walletStorage.removeItem("webwallet.version/0xabc")
  h.probe.mockResolvedValue(null)
  h.recordStale.mockResolvedValue(false)
  // 1 Choose shows once a session: these tests start from the offer.
  sessionStorage.setItem("zkm:upgrade-choose-shown", "1")
  sessionStorage.setItem("zkm:upgrade-moving-shown", "1")
  sessionStorage.setItem("zkm:upgrade-reopen-shown", "1")
  // 0.1 tip, 0.3 arrival fee.
  h.fee.mockResolvedValue({
    relayerTip: (10n ** 17n).toString(),
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
  resetApprovals()
  act(() => root.unmount())
  client.clear()
  container.remove()
  vi.useRealTimers()
})

let upgradeStatus = () => ({} as ReturnType<typeof useUpgradeStatus>)
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
        <MemoryRouter>
          <MigrationDetectionMount />
        </MemoryRouter>
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
/** The dialog alone, without the upgrade's screens. */
const dialog = () => document.querySelector('[data-testid="migration-detected-modal"]')
/** The dialog, or the page holding the upgrade's screens and sheets. */
const detectedModal = () =>
  document.querySelector('[data-testid="migration-detected-modal"]') ??
  (document.querySelector(".ww-cutover, .ww-cutover-sheet__body") ? document.body : null)
const upgradeSheet = () => document.querySelector('[data-testid="cutover-move-funds"]')
/** Upgrading's steps, and whether it heads them with what the run moves. */
const upgradingSteps = () =>
  [
    ...document.querySelectorAll(
      '[data-testid="cutover-upgrading"] [data-testid="cutover-steps"] li',
    ),
  ].map((li) => li.querySelector("b")?.textContent)
const movingHeader = () =>
  !!document.querySelector('[data-testid="cutover-upgrading"] .ww-cutover__steps-head')
/** A figures card on `testId`'s page or sheet. */
const figuresCard = (testId: string) =>
  !!document.querySelector(`[data-testid="${testId}"] .ww-cutover__details`)
/** Closes the open sheet as Escape does. */
async function closeSheet() {
  await act(async () => {
    document
      .querySelector(".ww-cutover-sheet__body")!
      .closest("dialog")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  })
}
/** The offer's start: the dialog's, or 2 Sign's in the full-screen upgrade. */
const upgradeButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="cutover-confirm-upgrade"]') ??
  button("Upgrade now") ??
  button("Confirm with passkey")
/** A stopped run's way on: a reopen screen's (S1 to S3), else the dialog's. */
const continueButton = () =>
  button("Resume") ??
  button("Retry") ??
  button("Start again") ??
  button("Continue upgrade") ??
  button("Approve and continue") ??
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Continue approving"),
  )
/** The Upgrading page's steps, as title and state. */
const upgradeSteps = () =>
  [...document.querySelectorAll('[data-testid="cutover-steps"] li')].map((li) => [
    li.querySelector("b")?.textContent,
    li.getAttribute("data-state"),
  ])
/** Continues a stopped run, through 2 Sign when S1 starts it again. */
async function continueStopped() {
  const start = !!button("Start again")
  await act(async () => continueButton()!.click())
  if (start) await act(async () => upgradeButton()!.click())
}
/** 2 Sign's first step, which counts the passkey approvals the upgrade asks for. */
const passkeyTimes = (n: number) =>
  `Confirm with passkey ${
    ["once", "twice", "three times", "four times", "five times", "six times"][n - 1]
  }`
/** Starts the upgrade from 1 Choose through 2 Sign, from an open 2 Sign, or from the dialog. */
async function startUpgrade() {
  const choose = document.querySelector<HTMLButtonElement>('[data-testid="cutover-upgrade"]')
  if (choose && !upgradeSheet()) await act(async () => choose.click())
  await act(async () => upgradeButton()!.click())
}

describe("MigrationDetectionMount — the record update with nothing to move", () => {
  const registrationService = () => ({
    needsMigration: async () => true,
    consentApprovals: async () => 1,
  })
  const probed = () =>
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [],
      residuals: [],
      pendingWithdrawals: 0,
    })

  it("offers the upgrade, counting the record update's one approval and a free network fee", async () => {
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: registrationService(),
    })
    probed()
    await render()
    const text = detectedModal()?.textContent
    expect(figuresCard("cutover-move-funds")).toBe(false)
    expect(text).toContain(passkeyTimes(1))
    expect(text).not.toContain("Deposit")
    expect(button("Withdraw funds instead")).toBeUndefined()
    expect(upgradeButton()).toBeDefined()
    expect(upgradeStatus()).toMatchObject({ state: "offered", registration: true })
  })

  it("shows the run as the account's update alone, with nothing moving", async () => {
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: registrationService(),
    })
    probed()
    h.runMetadata.mockImplementation(
      async (_c, opts: { prepareOnly?: boolean; signal: AbortSignal }) =>
        opts.prepareOnly
          ? { phase: "broadcasting", plan: "signed-plan" }
          : new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve(null))),
    )
    await render()
    await startUpgrade()
    expect(upgradingSteps()).toEqual(["Update your account"])
    expect(movingHeader()).toBe(false)
    h.runMetadata.mockReset()
  })

  it("ends on Upgrade complete without a balance, as nothing moved", async () => {
    withTokenService()
    const needsMigration = vi.fn(async () => true)
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: { ...registrationService(), needsMigration },
    })
    h.railPending = false
    probed()
    h.runMetadata.mockImplementation(async (_c, opts: { prepareOnly?: boolean }) => {
      if (opts.prepareOnly) return { phase: "broadcasting", plan: "signed-plan" }
      needsMigration.mockResolvedValue(false)
      return { phase: "done", plan: "signed-plan" }
    })
    try {
      await render()
      await startUpgrade()
      await act(async () => vi.advanceTimersByTimeAsync(50))
      expect(document.querySelector('[data-testid="cutover-upgrade-done"]')).not.toBeNull()
      expect(figuresCard("cutover-upgrade-done")).toBe(false)
    } finally {
      h.railPending = undefined
      h.runMetadata.mockReset()
    }
  })

  it("asks the approval in the user's flow and sends the bootstrap in the background", async () => {
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: registrationService(),
    })
    probed()
    h.runMetadata.mockImplementation(async (_c, opts: { prepareOnly?: boolean }) =>
      opts.prepareOnly
        ? { phase: "broadcasting", plan: "signed-plan" }
        : { phase: "done", plan: "signed-plan" },
    )
    await render()
    await startUpgrade()
    // runMigrationQueue.test covers the approvals pass that leads each queue.
    const passes = h.runMetadata.mock.calls
      .map(([, opts]) => opts)
      .filter((opts) => !opts.approvalsOnly)
    expect(passes[0]).toMatchObject({ prepareOnly: true, summary: { fees: "0", approvals: 1 } })
    expect(passes[1]).toMatchObject({ prompts: false, untilArriving: true })
    // What follows only observes the run it finished.
    expect(passes.slice(2).every((opts) => opts.observeOnly)).toBe(true)
    // This version's run updates the record: it is no funds-only run.
    const sessions = h.metadataSession.mock.calls.map(([params]) => params)
    expect(sessions.every((params) => !params.recoveryOnly)).toBe(true)
  })

  it("hands the record update to the bell once it is approved, and keeps its send", async () => {
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: registrationService(),
    })
    probed()
    let signal: AbortSignal | undefined
    h.runMetadata.mockImplementation(
      async (_c, opts: { prepareOnly?: boolean; signal: AbortSignal }) => {
        if (opts.prepareOnly) return { phase: "broadcasting", plan: "signed-plan" }
        signal = opts.signal
        return new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve(null)))
      },
    )
    await render()
    await startUpgrade()
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(signal?.aborted).toBe(false)
    h.runMetadata.mockReset()
  })

  it("offers the upgrade only once the figure its lock holds is known", async () => {
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: registrationService(),
    })
    probed()
    h.balance = { walletBalance: "0.00", balanceKnown: false }
    try {
      await render()
      expect(upgradeButton()!.disabled).toBe(true)

      h.balance = { walletBalance: "0.00", balanceKnown: true }
      await render()
      expect(upgradeButton()!.disabled).toBe(false)
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
        ...registrationService(),
        quote: async () => ({ movable: 0n, stranded: 10n ** 17n, waiting: 0n }),
      },
      holdings: async () => true,
    })
    h.runMetadata.mockImplementationOnce(async () => null)
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [dust.tuple],
      residuals: [dust],
      pendingWithdrawals: 0,
    })
    try {
      await render()
      await startUpgrade()

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

describe("MigrationDetectionMount — a registration run left at boot", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const registration = (over: Record<string, unknown> = {}) => ({
    phase: "awaitingMessages",
    plan: JSON.stringify({ sourceState: "empty" }),
    bootstrapTx: "0x" + "b0".repeat(32),
    ...over,
  })
  let snapshot: Record<string, unknown> | null
  let publish: () => void
  let restore = () => {}
  const saved = (record: Record<string, unknown> | null, key = "migration-registration") => {
    const read = webStorage.getItem.bind(webStorage)
    const spy = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (k) =>
        k === key ? (record ? JSON.stringify(record) : null) : read(k),
      )
    restore = () => spy.mockRestore()
  }
  type RunOptions = {
    signal: AbortSignal
    promptless?: boolean
    observeOnly?: boolean
    exclusive?: <T>(step: (operationId?: string) => Promise<T>) => Promise<T>
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
      service: { needsMigration: async () => true, consentApprovals: async () => 1 },
    })
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
  })
  afterEach(() => {
    restore()
    h.keyFor = undefined
  })

  it("carries a run left at boot to the end with no click and no prompt, each step in the background", async () => {
    snapshot = registration()
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

  /** A registration run stopped at `phase`, while an old version's funds are still being quoted. */
  const stoppedWhileQuoting = (phase: string) => {
    const old: HistoricResidualSummary = {
      ...incomplete,
      tuple: { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) } as never,
      frozen: true,
      incomplete: false,
      balance: 10n ** 17n,
    }
    snapshot = registration({ phase, bootstrapTx: undefined, error: "x" })
    saved(snapshot)
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
        consentApprovals: async () => 1,
        quote: () => new Promise(() => {}),
      },
    })
    h.probe.mockResolvedValue({
      current,
      historic: [old.tuple],
      residuals: [old],
      pendingWithdrawals: 0,
    })
    h.runMetadata.mockImplementation(async (_c, opts: RunOptions & { prepareOnly?: boolean }) =>
      opts.prepareOnly ? { ...snapshot, phase: "broadcasting" } : untilAborted(opts.signal),
    )
  }

  it("shows a resumed registration run as the account's update, though old funds are still quoted", async () => {
    stoppedWhileQuoting("needsAttention")
    try {
      await render({ request: false })
      expect(upgradeStatus().state).toBe("stopped")
      await continueStopped()

      expect(upgradingSteps()).toEqual(["Update your account"])
      expect(movingHeader()).toBe(false)
    } finally {
      h.runMetadata.mockReset()
    }
  })

  it("asks a resumed Sign for the account's update alone, as starting it queues, though old funds are still quoted", async () => {
    stoppedWhileQuoting("needsApproval")
    try {
      await render({ request: false })
      await act(async () => button("Start again")!.click())
      expect(figuresCard("cutover-move-funds")).toBe(false)
      await act(async () => upgradeButton()!.click())
      expect(upgradingSteps()).toEqual(["Update your account"])
    } finally {
      h.runMetadata.mockReset()
    }
  })

  it("shows the followed run as running, and never starts it again", async () => {
    snapshot = registration()
    saved(snapshot)
    h.runMetadata.mockImplementationOnce((_c: unknown, opts: RunOptions) =>
      untilAborted(opts.signal),
    )
    await render()
    expect(upgradeStatus()).toMatchObject({ state: "running", phase: "awaitingMessages" })
    expect(notes.store.get("migration:run")).toBeNull()
    expect(upgradeButton()).toBeUndefined()
    expect(runs()).toHaveLength(1)
  })

  it("leaves an old version's run to the user when this version has none", async () => {
    const old = { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) }
    h.keyFor = (portal) => `migration-test/${portal.toLowerCase()}`
    saved(
      registration({ plan: JSON.stringify({ sourceState: "frozen", recoveryOnly: true }) }),
      `migration-test/${old.portal.toLowerCase()}`,
    )
    h.probe.mockResolvedValue({ current, historic: [old], residuals: [], pendingWithdrawals: 0 })
    await render({ request: false })
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(upgradeStatus().state).toBe("stopped")
  })

  it("reads a follower that failed as a failed check, never as a paused run", async () => {
    snapshot = registration()
    saved(snapshot)
    h.runMetadata.mockRejectedValueOnce(new Error("session lost"))
    await render({ request: false })
    expect(upgradeStatus().state).toBe("failed")
  })

  it("never offers to start a run its follower is still opening", async () => {
    snapshot = registration()
    saved(snapshot)
    h.metadataSession.mockImplementation(async () => ({
      controller: {
        load: () => new Promise(() => {}),
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      },
      service: { needsMigration: async () => true, consentApprovals: async () => 1 },
    }))
    await render()
    expect(upgradeButton()).toBeUndefined()
    expect(h.runMetadata).not.toHaveBeenCalled()
  })

  it("shows a stop when the follower ends on one", async () => {
    snapshot = registration()
    saved(snapshot)
    let stop!: (record: unknown) => void
    h.runMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stop = resolve
        }),
    )
    await render()
    const stopped = registration({ phase: "needsApproval", error: "needs you" })
    await act(async () => {
      snapshot = stopped
      publish()
      stop(stopped)
    })
    // The record update moves no funds.
    expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
  })

  describe("beside an old version's saved run", () => {
    const old = { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) }
    const oldRun = {
      plan: JSON.stringify({ sourceState: "frozen", recoveryOnly: true }),
      phase: "broadcasting",
    }
    const residual: HistoricResidualSummary = {
      ...incomplete,
      tuple: old as never,
      frozen: true,
      incomplete: false,
      sweptDeposits: 1,
    }
    const both = (registrationRun: Record<string, unknown>, oldVersionRun = oldRun) => {
      h.keyFor = (portal) => `migration-test/${portal.toLowerCase()}`
      const records: Record<string, unknown> = {
        [`migration-test/${current.portal.toLowerCase()}`]: registrationRun,
        [`migration-test/${old.portal.toLowerCase()}`]: oldVersionRun,
      }
      const read = webStorage.getItem.bind(webStorage)
      const spy = vi
        .spyOn(webStorage, "getItem")
        .mockImplementation(async (k) => (k in records ? JSON.stringify(records[k]) : read(k)))
      restore = () => spy.mockRestore()
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: {
          historic,
          load: async () => {},
          getSnapshot: () => null,
          subscribe: () => () => {},
        },
        service: {
          needsMigration: async () => true,
          consentApprovals: async () => 1,
          quote: async () => ({
            movable: 10n ** 18n,
            stranded: 0n,
            waiting: 0n,
            approvals: 1,
            fees: 0n,
          }),
        },
      }))
      h.probe.mockResolvedValue({
        current,
        historic: [old],
        residuals: [residual],
        pendingWithdrawals: 0,
      })
    }
    type Controller = { historic: { portal: string } }
    const portals = (filter: (opts: RunOptions) => boolean) =>
      h.runMetadata.mock.calls
        .filter(([, opts]) => filter(opts as RunOptions))
        .map(([controller]) => (controller as Controller).historic.portal)

    // Each run's controller shows the phase the test sends it.
    const sendingRuns = async () => {
      const sending: Record<string, Record<string, unknown>> = {}
      const listeners: (() => void)[] = []
      const service = (await h.metadataSession.getMockImplementation()!({ historic: old } as never))
        .service
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: {
          historic,
          load: async () => {},
          getSnapshot: () => sending[historic.portal] ?? null,
          subscribe: (listener: () => void) => {
            listeners.push(listener)
            return () => {}
          },
        },
        service,
      }))
      const send = (portal: string, phase: string) => {
        sending[portal] = { phase, plan: "signed" }
        for (const listener of listeners) listener()
      }
      return { sending, send }
    }

    it("resumes the registration run first, and Continue queues the old version's run after it", async () => {
      both(registration({ phase: "needsApproval", error: "needs you", bootstrapTx: undefined }))
      h.runMetadata.mockImplementation(async (_c, opts: RunOptions & { prepareOnly?: boolean }) =>
        opts.observeOnly || opts.promptless
          ? untilAborted(opts.signal)
          : { plan: "signed", phase: opts.prepareOnly ? "broadcasting" : "arriving" },
      )
      await render()
      expect(upgradeStatus().state).toBe("stopped")
      await continueStopped()
      expect(portals((opts) => !opts.observeOnly && !opts.promptless).slice(0, 2)).toEqual([
        current.portal,
        old.portal,
      ])
    })

    it("follows a sent registration run in the background and leaves it out of Continue", async () => {
      both(registration())
      h.runMetadata.mockImplementation(async (_c, opts: RunOptions & { prepareOnly?: boolean }) =>
        opts.observeOnly || opts.promptless
          ? untilAborted(opts.signal)
          : { plan: "signed", phase: opts.prepareOnly ? "broadcasting" : "arriving" },
      )
      await render()
      // The registration run is followed; the old version's run waits on the user.
      expect(portals((opts) => !!opts.promptless)).toEqual([current.portal])
      await continueStopped()
      const queued = portals((opts) => !opts.observeOnly && !opts.promptless)
      expect(queued).toContain(old.portal)
      expect(queued).not.toContain(current.portal)
    })

    it("shows a resumed registration run's approvals with the old version's", async () => {
      both(
        registration({
          phase: "needsApproval",
          bootstrapTx: undefined,
          summary: { fees: "0", approvals: 1 },
        }),
      )
      h.runMetadata.mockImplementation(async (_c, opts: RunOptions) => untilAborted(opts.signal))
      await render()
      expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
      await act(async () => button("Start again")!.click())
      expect(detectedModal()?.textContent).toContain(passkeyTimes(2))
    })

    it("offers a reload's run mid-approvals counted with the registration run's, and Continue leads with it", async () => {
      both(
        registration({
          phase: "broadcasting",
          bootstrapTx: undefined,
          approvals: { approved: 1, total: 1 },
        }),
        { ...oldRun, phase: "preparing", approvals: { approved: 1, total: 5 } } as never,
      )
      h.runMetadata.mockImplementation(async (_c, opts: RunOptions & { prepareOnly?: boolean }) =>
        opts.observeOnly || opts.promptless
          ? untilAborted(opts.signal)
          : { plan: "signed", phase: opts.prepareOnly ? "broadcasting" : "arriving" },
      )
      await render()
      // One count over the upgrade: the record update's approval, then the old version's five.
      await continueStopped()
      expect(portals((opts) => !opts.observeOnly && !opts.promptless).slice(0, 2)).toEqual([
        current.portal,
        old.portal,
      ])
    })

    it("counts the record update's approval and the old version's as one while the run asks", async () => {
      both(registration({ phase: "needsApproval", error: "needs you", bootstrapTx: undefined }))
      const asking: Record<string, unknown> = {
        [current.portal]: { phase: "broadcasting", approvals: { approved: 1, total: 1 } },
        [old.portal]: { phase: "preparing", approvals: { approved: 0, total: 2 } },
      }
      const service = (await h.metadataSession.getMockImplementation()!({ historic: old } as never))
        .service
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: {
          historic,
          load: async () => {},
          getSnapshot: () => asking[historic.portal] ?? null,
          subscribe: (listener: () => void) => {
            listener()
            return () => {}
          },
        },
        service,
      }))
      h.runMetadata.mockImplementation(async (c: Controller, opts: RunOptions) =>
        opts.observeOnly || opts.promptless || c.historic.portal === old.portal
          ? untilAborted(opts.signal)
          : asking[current.portal],
      )
      await render()
      await continueStopped()
      // One approval of three: the ring's share of the approvals.
      expect(detectedModal()?.textContent).toContain("11%")
    })

    it("shows the account's update first, then the old version's withdrawal, as the queue sends", async () => {
      both(registration({ phase: "needsApproval", error: "needs you", bootstrapTx: undefined }))
      const { sending, send } = await sendingRuns()
      let registered!: () => void
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly || opts.promptless) return untilAborted(opts.signal)
          if (opts.prepareOnly) return { plan: "signed", phase: "broadcasting" }
          if (c.historic.portal === old.portal) {
            send(old.portal, "recovering")
            return untilAborted(opts.signal)
          }
          send(current.portal, "subscribing")
          await new Promise<void>((resolve) => (registered = resolve))
          send(current.portal, "arriving")
          return sending[current.portal]
        },
      )
      await render()
      await continueStopped()
      expect(upgradeSteps()).toEqual([
        ["Update your account", "active"],
        ["Withdraw from old wallet", "pending"],
        ["Deposit to new wallet", "pending"],
      ])
      await act(async () => registered())
      expect(upgradeSteps()).toEqual([
        ["Update your account", "done"],
        ["Withdraw from old wallet", "active"],
        ["Deposit to new wallet", "pending"],
      ])
    })

    it("never moves the ring back once the queue hands its last run to the follower", async () => {
      both(registration({ phase: "needsApproval", error: "needs you", bootstrapTx: undefined }))
      const { sending, send } = await sendingRuns()
      let handOff!: () => void
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly || opts.promptless) return untilAborted(opts.signal)
          if (opts.prepareOnly) return { plan: "signed", phase: "broadcasting" }
          if (c.historic.portal === current.portal) {
            send(current.portal, "done")
            return sending[current.portal]
          }
          send(old.portal, "arriving")
          await new Promise<void>((resolve) => (handOff = resolve))
          return sending[old.portal]
        },
      )
      await render()
      await continueStopped()
      // One run done, one arriving.
      expect(detectedModal()?.textContent).toContain("93%")
      await act(async () => handOff())
      expect(detectedModal()?.textContent).toContain("93%")
    })

    it("never moves the steps back while the check after the last run's arrival answers", async () => {
      const registrationRun = registration({
        phase: "needsApproval",
        error: "needs you",
        bootstrapTx: undefined,
      })
      const oldVersionRun = { ...oldRun }
      both(registrationRun, oldVersionRun)
      const { sending, send } = await sendingRuns()
      const service = (await h.metadataSession.getMockImplementation()!({ historic: old } as never))
        .service
      let arrive!: () => void
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly && c.historic.portal === old.portal) {
            await new Promise<void>((resolve) => (arrive = resolve))
            return { plan: "signed", phase: "done" }
          }
          if (opts.observeOnly || opts.promptless) return untilAborted(opts.signal)
          if (opts.prepareOnly) return { plan: "signed", phase: "broadcasting" }
          if (c.historic.portal === current.portal) {
            send(current.portal, "done")
            return sending[current.portal]
          }
          send(old.portal, "arriving")
          return sending[old.portal]
        },
      )
      await render()
      await continueStopped()
      h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
      service.needsMigration = () => new Promise(() => {})
      // Both runs saved as done, as the real runs save them.
      Object.assign(registrationRun, { phase: "done" })
      Object.assign(oldVersionRun, { phase: "done" })
      await act(async () => arrive())
      expect(upgradeSteps()).toEqual([
        ["Update your account", "done"],
        ["Withdraw from old wallet", "done"],
        ["Deposit to new wallet", "active"],
      ])
    })

    it("queues a registration run its follower left stopped ahead of an old version's run that stopped after it", async () => {
      both(registration(), { ...oldRun, phase: "waiting" })
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly) return untilAborted(opts.signal)
          if (!opts.promptless)
            return { plan: "signed", phase: opts.prepareOnly ? "broadcasting" : "arriving" }
          if (c.historic.portal === current.portal)
            return registration({ phase: "needsAttention", error: "The relayer is down" })
          await released
          return { ...oldRun, phase: "needsApproval", error: "needs you" }
        },
      )
      await render()
      await act(async () => release())
      await continueStopped()
      expect(portals((opts) => !opts.observeOnly && !opts.promptless).slice(0, 2)).toEqual([
        current.portal,
        old.portal,
      ])
    })
  })

  it("leaves a run that stopped for the user to the user", async () => {
    snapshot = registration({ phase: "needsApproval", error: "needs you" })
    saved(snapshot)
    await render({ request: false })
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(upgradeStatus().state).toBe("stopped")
  })
})

describe("MigrationDetectionMount — frozen sources", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
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
    expect(upgradeButton()).toBeDefined()
  })

  // Home's balances show what moves; the sheet shows what it costs (Figma 12709:36185).
  it("counts the approvals the upgrade asks for, with no fee and not what it moves", async () => {
    withTokenService()
    session({ movable: 30n * 10n ** 18n, batches: 3, approvals: 4, fees: 15n * 10n ** 17n })
    probe(frozen({ balance: 10n * 10n ** 18n, sweptDeposits: 2 }))
    await render()
    const text = detectedModal()?.textContent
    expect(text).toContain("Move your funds")
    expect(text).not.toContain("network fees")
    expect(text).toContain(passkeyTimes(4))
    expect(text).toContain("Keep zk.money open")
    for (const dropped of ["Amount", "Fees $", "You'll receive", "About an hour"])
      expect(text).not.toContain(dropped)
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
      expect(text).not.toContain("network fees")
      expect(text).toContain("Something went wrong")
    } finally {
      saved.mockRestore()
    }
  })

  it("adds the refunds a run takes to the notes, and names what no batch can afford", async () => {
    withTokenService()
    session({ movable: 30n * 10n ** 18n, stranded: 3n * 10n ** 17n })
    probe(frozen({ balance: 10n * 10n ** 18n, sweptDeposits: 2 }))
    await render()
    expect(residualsRow()).toMatchObject({ description: "$0.30 too small to move" })
  })

  it("names a source awaiting its freeze, never quotes it, and leaves it out of the move", async () => {
    withTokenService()
    session({ movable: 20n * 10n ** 18n })
    const live = { ...incomplete.tuple, portal: "0x" + "0c".repeat(20) }
    const awaiting = { ...incomplete, tuple: live as never, balance: 5n * 10n ** 18n }
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals: [
        frozen({ sweptDeposits: 2 }),
        { ...awaiting, incomplete: false, awaitingFreeze: true },
      ],
      pendingWithdrawals: 0,
    })
    await render()
    const quoted = h.metadataSession.mock.calls.map(([args]) => args.historic.portal)
    expect(quoted).not.toContain(live.portal)
    expect(upgradeButton()).toBeDefined()
    expect(residualsRow()?.description).toContain(
      "$5.00 on the old version. You can upgrade it once that version freezes.",
    )
  })

  it("offers a source that freezes after boot, once the re-probe reads it", async () => {
    withTokenService()
    session({ movable: 5n * 10n ** 18n })
    const v5 = { tuple: incomplete.tuple, balance: 5n * 10n ** 18n }
    h.probe.mockResolvedValue({
      current,
      historic: [],
      residuals: [{ ...incomplete, ...v5, incomplete: false, awaitingFreeze: true }],
      pendingWithdrawals: 0,
    })
    await render({ request: false })
    expect(upgradeStatus().state).not.toBe("offered")
    probe(frozen(v5))
    await act(async () => freeze.onFrozen())
    expect(upgradeStatus().state).toBe("offered")
  })

  it("waits for a frozen source's migration feature, and offers it once the manifest lists one", async () => {
    withTokenService()
    session({ movable: 5n * 10n ** 18n, fees: 0n, approvals: 1 })
    const waiting = frozen({ balance: 5n * 10n ** 18n, awaitingFeature: true })
    probe(waiting)
    await render()
    const quoted = h.metadataSession.mock.calls.map(([args]) => args.historic?.portal)
    expect(quoted).not.toContain(waiting.tuple.portal)
    expect(upgradeButton()).toBeUndefined()
    expect(document.body.textContent).toContain(
      "$5.00 is on the old version and can upgrade once the new version is ready",
    )
    expect(residualsRow()).toMatchObject({
      description: "$5.00 on the old version. You can upgrade it once the new version is ready.",
    })

    // Each poll reads only the manifest: no probe runs while it lists no route.
    const probes = h.probe.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.featureListed).toHaveBeenCalledWith([{ source: waiting.tuple, destination: current }])
    expect(h.probe.mock.calls.length).toBe(probes)

    // The manifest gains the feature: the poll sees it and the probe runs once more.
    h.featureListed.mockResolvedValueOnce(true)
    probe({ ...waiting, awaitingFeature: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.probe.mock.calls.length).toBeGreaterThan(probes)
    expect(upgradeButton()).toBeDefined()

    // No source waits now, so the watch stops.
    const after = h.probe.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(h.probe.mock.calls.length).toBe(after)
  })

  it("counts the unclaimed deposits of a waiting source in its waiting line", async () => {
    withTokenService()
    session({ movable: 5n * 10n ** 18n })
    probe(frozen({ sweptDeposits: 2, awaitingFeature: true }))
    await render()
    const text = document.body.textContent
    expect(text).toContain(
      "2 unclaimed deposits are on the old version and can upgrade once the new version is ready",
    )
    expect(text).not.toContain("can't be moved now")
    expect(residualsRow()).toMatchObject({
      description:
        "2 unclaimed deposit(s) on the old version. You can upgrade them once the new version is ready.",
    })
  })

  it("names a waiting source's balance and its deposits in one line", async () => {
    withTokenService()
    session({ movable: 5n * 10n ** 18n })
    probe(frozen({ balance: 5n * 10n ** 18n, sweptDeposits: 1, awaitingFeature: true }))
    await render()
    expect(document.body.textContent).toContain(
      "$5.00 and an unclaimed deposit are on the old version and can upgrade once the new version is ready",
    )
    expect(document.body.textContent).not.toContain("can't be moved now")
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
      current: { ...current, accountMetadataRegistry: undefined },
      historic: [incomplete.tuple],
      residuals: [frozen({ balance: 5n * 10n ** 17n })],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()).toBeNull()
    expect(h.metadataSession).not.toHaveBeenCalled()
    expect(residualsRow()).toMatchObject({ description: "$0.50 on a frozen version" })
  })

  it("values sUSDS sources in dollars and moves each source into its paired destination", async () => {
    withTokenService()
    const DAI = 10n ** 18n
    const savings = { ...current, portal: "0x" + "03".repeat(20), l2Token: "0x" + "04".repeat(32) }
    const dai = frozen({ tuple: { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) } as never })
    const susds = frozen({
      tuple: { ...incomplete.tuple, portal: "0x" + "0b".repeat(20) } as never,
    })
    h.tokenCreate.mockResolvedValue("savings-token-service")
    h.metadataSession.mockImplementation(async ({ historic }) => ({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({
          movable: historic.portal === dai.tuple.portal ? 100n * DAI : 10n * DAI,
          stranded: 0n,
          waiting: 0n,
          fees: DAI,
          approvals: 1,
        }),
        needsMigration: async () => false,
      },
    }))
    h.probe.mockResolvedValue({
      current,
      historic: [dai.tuple, susds.tuple],
      destinations: new Map([
        [susds.tuple.portal.toLowerCase(), { tuple: savings, symbol: "sUSDS" }],
      ]),
      residuals: [
        { ...dai, sweptDeposits: 1 },
        { ...susds, sweptDeposits: 1 },
      ],
      pendingWithdrawals: 0,
    })
    await render()
    const text = detectedModal()?.textContent
    expect(text).not.toContain("network fees")
    expect(text).toContain(passkeyTimes(2))
    expect(text).not.toContain("Also there: $12.00 on another old version.")
    expect(h.metadataSession).toHaveBeenCalledWith(
      expect.objectContaining({ historic: dai.tuple, current, toTokenService: {} }),
    )
    expect(h.metadataSession).toHaveBeenCalledWith(
      expect.objectContaining({
        historic: susds.tuple,
        current: savings,
        toTokenService: "savings-token-service",
      }),
    )
    // One click prepares both assets before it sends either asset.
    h.runMetadata.mockImplementation(async (_controller, options) => ({
      plan: "signed-plan",
      phase: options.prepareOnly ? "broadcasting" : "done",
    }))
    h.probe.mockResolvedValue({
      current,
      historic: [],
      destinations: new Map(),
      residuals: [],
      pendingWithdrawals: 0,
    })
    h.metadataSession.mockClear()
    await startUpgrade()
    expect(h.metadataSession.mock.calls[0]![0]).toMatchObject({ historic: dai.tuple, current })
    expect(h.metadataSession.mock.calls[1]![0]).toMatchObject({
      historic: susds.tuple,
      current: savings,
      recoveryOnly: true,
    })
    expect(h.metadataSession.mock.calls[0]![0].recoveryOnly).toBe(true)
    const steps = h.runMetadata.mock.calls
      .filter(([, options]) => !options.observeOnly && !options.approvalsOnly)
      .map(([, options]) => ({ prepare: !!options.prepareOnly, prompts: options.prompts }))
    expect(steps).toEqual([
      { prepare: true, prompts: undefined },
      { prepare: true, prompts: undefined },
      { prepare: false, prompts: false },
      { prepare: false, prompts: false },
    ])
  })

  it("names deposits that wait for L1 finality", async () => {
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
          quote: async () => {
            const which = historic.portal === a.portal ? "a" : "b"
            calls.push([which, undefined])
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

    it("quotes both sources and includes the other in the resumed upgrade", async () => {
      const { calls } = await resume("recovering", { a: 30n, b: 50n })
      expect(detectedModal()?.textContent).not.toContain(
        "Also there: $30.00 on another old version.",
      )
      expect(calls.map(([which]) => which)).toEqual(expect.arrayContaining(["a", "b"]))
    })

    it("leaves a followed source out of the queue when the other run is continued", async () => {
      withTokenService()
      // `a` arrives and is followed at boot; `b` stopped and is offered.
      h.keyFor = (portal) =>
        portal === a.portal ? "migration-a" : portal === b.portal ? "migration-b" : "migration-new"
      const records: Record<string, object> = {
        "migration-a": { plan: "signed-plan", phase: "arriving" },
        "migration-b": { plan: "signed-plan", phase: "recovering" },
      }
      const read = webStorage.getItem.bind(webStorage)
      const saved = vi
        .spyOn(webStorage, "getItem")
        .mockImplementation(async (key) =>
          key in records ? JSON.stringify(records[key]) : read(key),
        )
      restore = () => {
        saved.mockRestore()
        h.keyFor = undefined
      }
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: {
          portal: historic.portal,
          load: async () => {},
          getSnapshot: () => null,
          subscribe: () => () => {},
        },
        service: {
          quote: async () => ({ movable: 30n * DAI, stranded: 0n, waiting: 0n }),
          needsMigration: async () => false,
        },
      }))
      // The follow of `a` observes until the mount ends; a user's pass runs through.
      h.runMetadata.mockImplementation(async (_controller, options) =>
        options.observeOnly
          ? new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(null)))
          : { plan: "signed-plan", phase: options.prepareOnly ? "broadcasting" : "arriving" },
      )
      h.probe.mockResolvedValue({
        current,
        historic: [a, b],
        residuals: [
          frozen({ tuple: a as never, sweptDeposits: 1 }),
          frozen({ tuple: b as never, sweptDeposits: 1 }),
        ],
        pendingWithdrawals: 0,
      })
      await render()
      expect(continueButton()).toBeDefined()
      await continueStopped()
      const ran = h.runMetadata.mock.calls
        .filter(([, options]) => !options.observeOnly)
        .map(([controller]) => (controller as { portal: string }).portal)
      expect(ran).toContain(b.portal)
      expect(ran).not.toContain(a.portal)
    })

    it("quotes again once a run stops, not from before it", async () => {
      const stranded: { b?: bigint } = {}
      const { record } = await resume("recovering", { a: 30n, b: 50n }, stranded)
      expect(detectedModal()?.textContent).not.toContain("too small to move")
      // The run's first refund executes before it stops, and leaves dust no batch affords.
      stranded.b = 3n * 10n ** 17n
      h.runMetadata.mockResolvedValue({ ...record, phase: "needsAttention", error: "x" })
      await continueStopped()
      expect(residualsRow()?.description).toContain("$0.30 too small to move")
    })
  })

  it("takes a quoted source's waiting deposits from its quote", async () => {
    withTokenService()
    session({ movable: 40n * 10n ** 18n })
    probe(
      frozen({ balance: 30n * 10n ** 18n, waitingDeposits: 1, waitingAmount: 10n * 10n ** 18n }),
    )
    await render()
    expect(upgradeButton()).toBeDefined()
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

describe("MigrationDetectionMount — sUSDS through the migration executor", () => {
  const DAI = 10n ** 18n
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const SUSDS_PORTAL = "0x" + "0b".repeat(20)
  const savings = { ...current, portal: "0x" + "03".repeat(20), l2Token: "0x" + "04".repeat(32) }
  const frozen = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary => ({
    ...incomplete,
    frozen: true,
    incomplete: false,
    ...over,
  })
  const dai = frozen({
    tuple: { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) } as never,
    sweptDeposits: 1,
  })
  const susds = frozen({
    tuple: { ...incomplete.tuple, portal: SUSDS_PORTAL } as never,
    balance: 10n * DAI,
  })
  /** Sessions by source: the sUSDS source moves only funds, through its migration executor. */
  const sessions = ({
    daiMovable = 0n,
    registration = true,
    executor = [SUSDS_PORTAL],
  }: { daiMovable?: bigint; registration?: boolean; executor?: string[] } = {}) =>
    h.metadataSession.mockImplementation(
      async ({ historic }: { historic: { portal: string } }) => ({
        fundsOnly: executor.includes(historic.portal),
        controller: {
          historic,
          load: async () => {},
          getSnapshot: () => null,
          subscribe: () => () => {},
        },
        service: {
          quote: async () =>
            executor.includes(historic.portal)
              ? { movable: 10n * DAI, stranded: 0n, waiting: 0n, fees: 0n, approvals: 1 }
              : { movable: daiMovable, stranded: 0n, waiting: 0n, fees: DAI, approvals: 2 },
          needsMigration: async () => registration,
          consentApprovals: async () => (registration ? 1 : 0),
        },
      }),
    )
  const probe = (residuals: HistoricResidualSummary[]) =>
    h.probe.mockResolvedValue({
      current,
      historic: residuals.map((r) => r.tuple),
      destinations: new Map([[SUSDS_PORTAL.toLowerCase(), { tuple: savings, symbol: "sUSDS" }]]),
      residuals,
      pendingWithdrawals: 0,
    })
  const sessionFor = (portal: string) =>
    h.metadataSession.mock.calls.map(([o]) => o).filter((o) => o.historic.portal === portal)
  type Controller = { historic: { portal: string } }
  type Options = {
    signal: AbortSignal
    prepareOnly?: boolean
    approvalsOnly?: boolean
    prompts?: boolean
    promptless?: boolean
    observeOnly?: boolean
  }
  const untilAborted = (signal: AbortSignal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)))
  /** Every run's passes go through: the registration run is done once sent, each follower arrives. */
  const runAll = (registrationSent: () => Promise<unknown> = async () => {}) =>
    h.runMetadata.mockImplementation(async (controller: Controller, options: Options) => {
      if (options.observeOnly || options.promptless) return untilAborted(options.signal)
      if (options.prepareOnly) return { plan: "signed", phase: "broadcasting" }
      if (controller.historic.portal === current.portal) {
        await registrationSent()
        return { plan: "signed", phase: "done" }
      }
      return { plan: "signed", phase: "arriving" }
    })
  /** Every pass run on a source, except the follows of the runs it finished and the approvals pass. */
  const passesOf = (portal: string) =>
    runsOf(portal)
      .filter((o) => !o.observeOnly && !o.approvalsOnly)
      .map((o) => ({ prepare: !!o.prepareOnly, prompts: o.prompts }))
  const runsOf = (portal: string) =>
    h.runMetadata.mock.calls
      .filter(([controller]) => (controller as Controller).historic.portal === portal)
      .map(([, options]) => options as Options)

  beforeEach(() => {
    withTokenService()
    h.tokenCreate.mockResolvedValue("savings-token-service")
  })

  it("updates an outdated tag first, then moves DAI and sUSDS as funds only, with no deposit", async () => {
    const daiPortal = (dai.tuple as { portal: string }).portal
    sessions({ daiMovable: 100n * DAI, executor: [SUSDS_PORTAL, daiPortal] })
    probe([susds, dai])
    await render()
    const text = detectedModal()?.textContent
    expect(text).not.toContain("Deposit")
    // The record update's approval, then one for each source's batch.
    expect(text).toContain(passkeyTimes(3))
    runAll()
    h.metadataSession.mockClear()
    await startUpgrade()

    const created = h.metadataSession.mock.calls.map(([o]) => o)
    expect(created[0]).toMatchObject({ historic: current, current })
    expect(created[0].recoveryOnly).toBeUndefined()
    // The queue's jobs come first; the scan after the run creates more.
    expect(created.slice(1, 3).map((o) => o.historic.portal)).toEqual([SUSDS_PORTAL, daiPortal])
    expect(created.slice(1, 3).every((o) => o.recoveryOnly)).toBe(true)
    for (const portal of [current.portal, SUSDS_PORTAL, daiPortal])
      expect(passesOf(portal)).toEqual([
        { prepare: true, prompts: undefined },
        { prepare: false, prompts: false },
      ])
  })

  it("moves DAI and sUSDS both as funds only once the tag is current", async () => {
    sessions({
      daiMovable: 100n * DAI,
      registration: false,
      executor: [SUSDS_PORTAL, (dai.tuple as { portal: string }).portal],
    })
    probe([susds, dai])
    await render()
    expect(detectedModal()?.textContent).not.toContain("network fees")
    h.runMetadata.mockImplementation(async (_controller, options) => ({
      plan: "signed",
      phase: options.prepareOnly ? "broadcasting" : "done",
    }))
    probe([])
    h.metadataSession.mockClear()
    await startUpgrade()

    expect(h.metadataSession.mock.calls[0]![0]).toMatchObject({
      historic: dai.tuple,
      current,
      recoveryOnly: true,
    })
    expect(h.metadataSession.mock.calls[1]![0]).toMatchObject({
      historic: susds.tuple,
      current: savings,
      recoveryOnly: true,
    })
  })

  it("with only sUSDS to move, keeps the tag with no DAI and still moves the sUSDS", async () => {
    sessions()
    probe([susds])
    await render()
    const text = detectedModal()?.textContent
    expect(text).not.toContain("Deposit")
    expect(text).toContain(passkeyTimes(2))
    // The sUSDS source never updates the record.
    expect(sessionFor(SUSDS_PORTAL).every((o) => o.current === savings)).toBe(true)
    runAll()
    await startUpgrade()

    expect(sessionFor(current.portal).at(-1)).toMatchObject({ historic: current, current })
    expect(sessionFor(SUSDS_PORTAL).find((o) => o.recoveryOnly)).toMatchObject({
      historic: susds.tuple,
      current: savings,
      recoveryOnly: true,
    })
    expect(passesOf(SUSDS_PORTAL)).toEqual([
      { prepare: true, prompts: undefined },
      { prepare: false, prompts: false },
    ])
  })

  it("shows a follower that stops for an approval as the run to continue", async () => {
    sessions()
    probe([susds])
    await render()
    const refused = {
      plan: "signed",
      phase: "needsApproval",
      refused: true,
      error: "The passkey request was closed",
    }
    h.runMetadata.mockImplementation(async (controller: Controller, options: Options) => {
      if (options.observeOnly || options.promptless) return untilAborted(options.signal)
      if (controller.historic.portal === current.portal)
        return { plan: "signed", phase: "broadcasting" }
      return refused
    })
    await startUpgrade()

    expect(upgradeStatus()).toMatchObject({ state: "stopped", phase: "needsApproval" })
    expect(continueButton()).toBeDefined()
    expect(notes.store.get("migration:run")).toMatchObject({
      description: "Your upgrade needs another approval. Open it to continue.",
    })
    // The stop came in the approvals pass: nothing was proven or sent.
    expect(passesOf(current.portal)).toEqual([])
    expect(runsOf(current.portal).filter((o) => !o.observeOnly)).toEqual([
      expect.objectContaining({ approvalsOnly: true }),
    ])
  })

  it("sends a follower's funds only once the registration run is done", async () => {
    sessions()
    probe([susds])
    await render()
    let sent!: () => void
    const registrationSent = new Promise<void>((resolve) => (sent = resolve))
    runAll(() => registrationSent)
    await startUpgrade()
    // Both runs are approved, and the registration run's send pass is still going.
    expect(passesOf(SUSDS_PORTAL)).toEqual([{ prepare: true, prompts: undefined }])
    expect(upgradeStatus().state).not.toBe("stopped")

    await act(async () => sent())
    expect(passesOf(SUSDS_PORTAL)).toEqual([
      { prepare: true, prompts: undefined },
      { prepare: false, prompts: false },
    ])
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("offers sUSDS alone once the tag is current, without a fee line", async () => {
    sessions({ registration: false })
    probe([susds])
    await render()
    const text = detectedModal()?.textContent
    expect(upgradeButton()).toBeDefined()
    expect(text).not.toContain("pay no tip")
    expect(text).not.toContain("network fees")
    expect(text).not.toContain("Deposit to keep your tag")
    expect(text).toContain(passkeyTimes(1))
  })

  it("is done only once the sUSDS run lands after the DAI run", async () => {
    h.railPending = false
    const daiPortal = (dai.tuple as { portal: string }).portal
    sessions({ daiMovable: 100n * DAI, registration: false, executor: [SUSDS_PORTAL, daiPortal] })
    h.keyFor = (portal) => `migration-test/${portal.toLowerCase()}`
    const records = new Map<string, string>()
    const read = webStorage.getItem.bind(webStorage)
    const saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) => records.get(key) ?? read(key))
    let land!: () => void
    const landed = new Promise<void>((resolve) => (land = resolve))
    try {
      probe([susds, dai])
      h.runMetadata.mockImplementation(async (controller: Controller, options: Options) => {
        const portal = controller.historic.portal
        const save = (phase: string) => {
          records.set(`migration-test/${portal}`, JSON.stringify({ plan: "signed", phase }))
          return { plan: "signed", phase }
        }
        if (options.prepareOnly) return save("broadcasting")
        if (!options.observeOnly) {
          // A sent source holds nothing more on its old version, which stays listed.
          h.probe.mockResolvedValue({
            current,
            historic: [susds.tuple, dai.tuple],
            destinations: new Map([
              [SUSDS_PORTAL.toLowerCase(), { tuple: savings, symbol: "sUSDS" }],
            ]),
            residuals: [],
            pendingWithdrawals: 0,
          })
          return save("arriving")
        }
        if (portal === SUSDS_PORTAL) await Promise.race([landed, untilAborted(options.signal)])
        return options.signal.aborted ? save("arriving") : save("done")
      })
      await render()
      await startUpgrade()
      await act(async () => vi.advanceTimersByTimeAsync(50))

      expect(upgradeStatus().state).toBe("running")
      expect(detectedModal()?.textContent).not.toContain("Upgrade complete")

      await act(async () => land())
      await act(async () => vi.advanceTimersByTimeAsync(50))
      expect(detectedModal()?.textContent).toContain("Upgrade complete")
      // Its sources read empty by now; the run still moved funds.
      expect(figuresCard("cutover-upgrade-done")).toBe(true)
    } finally {
      saved.mockRestore()
    }
  })

  describe("a DAI source through its own migration executor", () => {
    const daiPortal = (dai.tuple as { portal: string }).portal
    const daiFunds = { ...dai, sweptDeposits: 0, balance: 10n * DAI }
    /** Every step run on the DAI source: only queue steps, never a record update. */
    const daiSteps = () => passesOf(daiPortal)

    it("never updates the tag: the registration run does, and the DAI follows it", async () => {
      sessions({ executor: [daiPortal] })
      probe([daiFunds])
      await render()
      expect(detectedModal()?.textContent).not.toContain("Deposit")
      expect(upgradeButton()).toBeDefined()

      runAll()
      await startUpgrade()

      expect(sessionFor(current.portal).at(-1)).toMatchObject({ historic: current, current })
      // The DAI source is quoted and moved as funds only.
      expect(sessionFor(daiPortal).filter((o) => o.recoveryOnly).length).toBeGreaterThan(0)
      expect(daiSteps()).toEqual([
        { prepare: true, prompts: undefined },
        { prepare: false, prompts: false },
      ])
    })

    it("is offered alone, funds only, once the tag is current", async () => {
      sessions({ executor: [daiPortal], registration: false })
      probe([daiFunds])
      await render()
      const text = detectedModal()?.textContent
      expect(text).not.toContain("network fees")
      expect(text).not.toContain("Deposit to keep your tag")

      runAll()
      h.metadataSession.mockClear()
      await startUpgrade()

      expect(h.metadataSession.mock.calls[0]![0]).toMatchObject({
        historic: dai.tuple,
        current,
        recoveryOnly: true,
      })
    })
  })
})

describe("MigrationDetectionMount — what is left on an old version", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
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
      "A deposit waiting: Ethereum hasn't finalized it yet",
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
    expect(upgradeButton()).toBeDefined()
  })
})

describe("MigrationDetectionMount — registration with nothing to move", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
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
              ? {
                  movable: 85n * 10n ** 18n,
                  stranded: 0n,
                  waiting: 0n,
                  batches: 2,
                  approvals: 2,
                  fees: 0n,
                }
              : { movable: 0n, stranded, waiting: 0n },
          needsMigration,
          consentApprovals: async () => 1,
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
  const registrationPrompt = () => !!detectedModal() && !!upgradeButton()
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
          <MemoryRouter>
            <MigrationDetectionMount />
          </MemoryRouter>
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
    expect(upgradeButton()).toBeDefined()
    expect(sessionFor).toHaveBeenCalledWith(current.portal)
    expect(flag()).toBe(true)
  })

  it("checks the registration while the old version is still being quoted", async () => {
    let quoted!: (value: boolean) => void
    movable.mockReturnValue(new Promise<boolean>((resolve) => (quoted = resolve)))
    needsMigration.mockClear()
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    expect(needsMigration).toHaveBeenCalledTimes(1)
    expect(upgradeStatus().state).toBe("checking")
    await act(async () => quoted(true))
    expect(upgradeStatus()).toMatchObject({ state: "offered", registration: true })
    expect(needsMigration).toHaveBeenCalledTimes(1)
  })

  it("counts a failed registration check only once the quotes find nothing to move", async () => {
    let quoted!: (value: boolean) => void
    movable.mockReturnValue(new Promise<boolean>((resolve) => (quoted = resolve)))
    needsMigration.mockRejectedValue(new Error("node down"))
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    expect(needsMigration).toHaveBeenCalled()
    expect(upgradeStatus().state).toBe("checking")
    await act(async () => quoted(true))
    expect(upgradeStatus().state).toBe("failed")
  })

  it("asks for it when an old balance can't pay its own exit", async () => {
    stranded = 10n ** 17n
    probe(frozen({ balance: 10n ** 17n }))
    await render()
    expect(movable).toHaveBeenCalledTimes(1)
    expect(registrationPrompt()).toBe(true)
    expect(residualsRow()).toMatchObject({ description: "$0.10 too small to move" })
  })

  it("keeps Withdraw for an old balance the upgrade can't move but a refund can", async () => {
    stranded = 10n ** 17n
    probe(frozen({ balance: 10n ** 17n }))
    await render()
    expect(registrationPrompt()).toBe(true)
    expect(figuresCard("cutover-move-funds")).toBe(false)
    expect(button("Withdraw funds instead")).toBeDefined()
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
    expect(upgradeStatus().state).toBe("failed")
  })

  it("waits for a retry's own movability before asking", async () => {
    probe(incomplete, frozen({ balance: 10n ** 17n }))
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    let settle!: (movable: boolean) => void
    movable.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await act(async () => retryButton()!.click())
    expect(needsMigration).toHaveBeenCalled()
    expect(registrationPrompt()).toBeFalsy()
    await act(async () => settle(true))
    // The record update leads, and the frozen source's funds follow it.
    expect(upgradeButton()).toBeDefined()
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
    needsMigration.mockResolvedValue(false)
    const transit = { inTransitDeposits: 1, inTransitAmount: 10n * 10n ** 18n }
    probe(frozen({ balance: 85n * 10n ** 18n, ...transit }))
    await render()
    expect(residualsRow()?.description).toContain("$10.00 in transit")
    // The deposit arrives before the run stops.
    probe(frozen({ balance: 95n * 10n ** 18n }))
    h.runMetadata.mockResolvedValue({ plan: "signed-plan", phase: "needsAttention", error: "x" })
    await startUpgrade()
    expect(detectedModal()?.textContent).not.toContain("in transit")
  })

  it("updates an outdated tag first, with a movable frozen source following it in one queue", async () => {
    movable.mockResolvedValue(true)
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    // The record update's approval and both batches'; nothing asks for a deposit.
    expect(detectedModal()?.textContent).toContain(passkeyTimes(3))
    expect(detectedModal()?.textContent).not.toContain("Deposit")
    h.metadataSession.mockClear()
    h.runMetadata.mockImplementation(async (_c, opts: { prepareOnly?: boolean }) =>
      opts.prepareOnly
        ? { phase: "broadcasting", plan: "plan" }
        : { phase: "arriving", plan: "plan" },
    )
    await startUpgrade()
    const sessions = h.metadataSession.mock.calls.map(([params]) => params)
    expect(sessions[0]).toMatchObject({ historic: current })
    expect(sessions[0].recoveryOnly).toBeUndefined()
    expect(sessions[1]).toMatchObject({ historic: incomplete.tuple, recoveryOnly: true })
    h.runMetadata.mockReset()
  })

  it("updates the tag when an old version's source can't be opened for the queue", async () => {
    movable.mockResolvedValue(true)
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    const open = h.metadataSession.getMockImplementation()!
    h.metadataSession.mockImplementation(async (params) => {
      if (params.historic.portal !== current.portal) throw new Error("manifest unreadable")
      return open(params)
    })
    h.runMetadata.mockImplementation(async (_c, opts: { prepareOnly?: boolean }) =>
      opts.prepareOnly
        ? { phase: "broadcasting", plan: "plan" }
        : { phase: "arriving", plan: "plan" },
    )
    await startUpgrade()
    expect(sessionFor).toHaveBeenCalledWith(incomplete.tuple.portal)
    expect(h.runMetadata.mock.calls[0]?.[1]).toMatchObject({ prepareOnly: true })
    h.runMetadata.mockReset()
  })

  it("moves a frozen source alone, funds only, once the tag is current", async () => {
    movable.mockResolvedValue(true)
    needsMigration.mockResolvedValue(false)
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    expect(detectedModal()?.textContent).toContain("Move your funds")
    h.metadataSession.mockClear()
    h.runMetadata.mockResolvedValueOnce({ plan: "signed-plan", phase: "broadcasting" })
    await startUpgrade()
    expect(h.metadataSession.mock.calls[0]![0]).toMatchObject({
      historic: incomplete.tuple,
      recoveryOnly: true,
    })
    // The user's pass only prepares. The send pass is not a user flow: each send waits its turn.
    const calls = h.runMetadata.mock.calls.map(([, o]) => o)
    expect(calls.map((o) => ({ prepare: !!o.prepareOnly, prompts: o.prompts }))).toEqual([
      { prepare: true, prompts: undefined },
      { prepare: false, prompts: false },
    ])
    expect(calls[0].exclusive).toBeUndefined()
    expect(calls[1]).toMatchObject({ retry: true, untilArriving: true })
    expect(calls[1].exclusive).toEqual(expect.any(Function))
  })

  it("reopens 2 Sign on request after a close", async () => {
    probe()
    await render()
    await closeSheet()
    expect(upgradeSheet()).toBeNull()
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
      service: { needsMigration: async () => true, consentApprovals: async () => 1 },
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
      accountMetadataRegistry: "0x" + "56".repeat(20),
    }
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
    await render()
    expect(h.runMetadata).not.toHaveBeenCalled()
    await act(async () => {
      upgradeButton()!.click()
      upgradeButton()?.click()
    })
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
    expect(h.runMetadata).toHaveBeenCalledWith(
      controller,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    // 3 stands in for 2 Sign until the run is prepared.
    expect(upgradeButton()).toBeUndefined()
    await act(async () => finish())
    // S3 explains the stop.
    expect(detectedModal()?.textContent).toContain("A step could not finish")
    const resume = continueButton()!
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
        accountMetadataRegistry: "0x" + "56".repeat(20),
      }
      h.probe.mockResolvedValue({
        current,
        historic: [{ ...incomplete.tuple, portal: "0x" + "02".repeat(20) }],
        residuals: [],
        pendingWithdrawals: 0,
      })
      await render()
      expect(continueButton()).toBeDefined()
      expect(h.runMetadata).not.toHaveBeenCalled()
      await continueStopped()
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
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
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
    expect(dialog()).toBeNull()
  })

  it("shows Upgrading for the followed run on every launch", async () => {
    h.runMetadata.mockImplementation(() => new Promise(() => {}))
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(detectedModal()?.textContent).toContain("Safe to close the app")
    act(() => root.unmount())
    root = createRoot(container)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrading...")
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
    expect(dialog()).toBeNull()
  })

  it("lists what is left when the residuals row asks, while the run is followed", async () => {
    h.runMetadata.mockImplementation(() => new Promise(() => {}))
    await render({ request: false })
    await act(async () => openMigrationDialog("residuals"))
    expect(upgradeStatus().state).toBe("running")
    expect(document.querySelector('[data-testid="migration-residuals-modal"]')).not.toBeNull()
  })

  it("shows S1, not a dialog, when the followed run needs the user", async () => {
    h.runMetadata.mockResolvedValue({ ...record, phase: "needsApproval" })
    await render({ request: false })
    expect(dialog()).toBeNull()
    expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
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
    expect(upgradeButton()).toBeUndefined()
  })

  it("asks, once opened, to continue a run that needs the user", async () => {
    h.runMetadata.mockResolvedValue({ ...record, phase: "recovering" })
    await render()
    expect(continueButton()).toBeDefined()
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
    waitReason?: string
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
  /** The start's prepare pass approves everything, and ends before its send pass. */
  const prepares = () =>
    h.runMetadata.mockImplementationOnce(
      async (_c: unknown, o: { onPrepared?: () => void; prepareOnly?: boolean }) => {
        expect(o.prepareOnly).toBe(true)
        o.onPrepared?.()
        snapshot = { phase: "broadcasting", plan: "p" }
        publish()
        return snapshot
      },
    )
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
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
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
    await startUpgrade()
  }

  it("starts an upgrade that only moves funds at the withdrawal: the account is already updated", async () => {
    runTo(null, false)
    await move()
    expect(upgradeSteps()).toEqual([
      ["Update your account", "done"],
      ["Withdraw from old wallet", "active"],
      ["Deposit to new wallet", "pending"],
    ])
  })

  it("asks to keep zk.money open before and once a run starts, and saves what the start was quoted", async () => {
    quote.mockResolvedValue({
      movable: 20n * 10n ** 18n,
      stranded: 0n,
      waiting: 0n,
      batches: 2,
      approvals: 3,
      fees: 10n ** 18n,
    })
    runTo(null, false)
    await render()
    expect(detectedModal()?.textContent).toContain("Keep zk.money open")
    await startUpgrade()
    expect(detectedModal()?.textContent).toContain("Leaving now stops the upgrade.")
    expect(h.runMetadata.mock.calls[0]![1]).toMatchObject({
      summary: { fees: (10n ** 18n).toString(), approvals: 3 },
    })
  })

  it("stops asking to keep the tab open once every batch is sent", async () => {
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo(null, false)
    await move()
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Moving your funds")
    expect(upgradingSteps()).toEqual([
      "Update your account",
      "Withdraw from old wallet",
      "Deposit to new wallet",
    ])
    expect(movingHeader()).toBe(true)
    expect(detectedModal()?.textContent).not.toContain("Keep zk.money open")
  })

  it("keeps Moving at the figure the upgrade started with once the funds land", async () => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    markOldHoldingsRead("0xabc")
    await BalanceStorage.get(webStorage).updateBalance(
      oldVersionScope(source.portal, "0xabc"),
      source.l2Token,
      20n * 10n ** 18n,
    )
    const header = () =>
      document.querySelector('[data-testid="cutover-upgrading"] .ww-cutover__steps-head b')
        ?.textContent
    try {
      prepares()
      runTo({ phase: "arriving", plan: "p" })
      runTo(null, false)
      await move()
      await act(async () => openMigrationDialog())
      expect(header()).toBe("$20.00")

      // The old version's record still holds the funds until the next check reads it.
      h.balance = { walletBalance: "20.00", balanceKnown: true }
      await render({ request: false })
      expect(header()).toBe("$20.00")
    } finally {
      h.balance = { walletBalance: "0.00", balanceKnown: true }
      walletStorage.removeItem("webwallet.identity")
      walletStorage.removeItem(`webwallet.oldHoldingsRead/${BOOTED_PORTAL.toLowerCase()}/0xabc`)
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(source.portal, "0xabc"),
        source.l2Token,
        0n,
      )
    }
  })

  // The run saves `arriving` before its last pass ends, and the bell keeps the tab until it does.
  it("keeps zk.money open at arriving, on 3 and every screen, until the run lets go", async () => {
    let finish!: (record: RunRecord) => void
    prepares()
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
    expect(detectedModal()?.textContent).toContain("Keep zk.money open")
    const shell = document.createElement("div")
    const shellRoot = createRoot(shell)
    await act(async () => shellRoot.render(<UpgradeKeepOpenBanner />))
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(shell.textContent).toContain("Keep zk.money open")
    await act(async () => finish({ phase: "arriving", plan: "p" }))
    expect(shell.textContent).toBe("")
    expect(detectedModal()?.textContent).toContain("Moving your funds")
    await act(async () => shellRoot.unmount())
  })

  it("continues a saved run on the quote its start saved", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x" })
    runTo(null, false)
    await render()
    await continueStopped()
    expect(h.runMetadata.mock.calls[0]![1].summary).toBeUndefined()
  })

  it("holds the upgrade through every approval, and Cancel asks, then stops it sending nothing", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        signal = o.signal
        await o.beforeApproval?.(0, 2)
        snapshot = { phase: "preparing", draft: "d", approvals: { approved: 1, total: 2 } }
        publish()
        await o.beforeApproval?.(1, 2)
        return untilAborted(o.signal)
      },
    )
    await move()
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    expect(operation()?.state).toBe("local")
    await act(async () => button("Cancel")!.click())
    expect(detectedModal()?.textContent).toContain("Leave upgrade?")
    expect(signal.aborted).toBe(false)
    await act(async () => button("Stop upgrade")!.click())
    expect(signal.aborted).toBe(true)
    expect(operation()).toBeUndefined()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(detectedModal()?.textContent).not.toContain("Upgrading...")
  })

  it("keeps Upgrading up while the sends go on, with no Close", async () => {
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo(null, false)
    await move()
    expect(detectedModal()?.textContent).toContain("Safe to close the app")
    expect(button("Close")).toBeUndefined()
    expect(h.runMetadata.mock.calls.at(-1)![1].signal.aborted).toBe(false)
  })

  it("asks before Back leaves 3, over a pending approval, and Stop upgrade stops the run", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        signal = o.signal
        await o.beforeApproval?.(0, 2)
        snapshot = { phase: "preparing", draft: "d", approvals: { approved: 1, total: 2 } }
        publish()
        await o.beforeApproval?.(1, 2)
        return untilAborted(o.signal)
      },
    )
    await move()
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    expect(detectedModal()?.textContent).toContain("Leave upgrade?")
    expect(detectedModal()?.textContent).not.toContain("Approval 2 of 2")
    await act(async () => button("Stay and finish")!.click())
    expect(detectedModal()?.textContent).not.toContain("Leave upgrade?")
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    expect(signal.aborted).toBe(false)
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    await act(async () => button("Stop upgrade")!.click())
    expect(signal.aborted).toBe(true)
    expect(detectedModal()?.textContent).not.toContain("Leave upgrade?")
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("hands the run to the bell once everything is approved, and keeps it running", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce(
      (_c: unknown, o: { onPrepared(): void; signal: AbortSignal }) => {
        signal = o.signal
        o.onPrepared()
        return untilAborted(o.signal)
      },
    )
    await move()
    // The send still holds this tab, so 3 stays until it lets go.
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(operation()?.handedOffAt).toBeDefined()
    expect(signal.aborted).toBe(false)
    // Funds may have moved, so Back does not say the upgrade starts over.
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    expect(detectedModal()?.textContent).toContain("Your upgrade will pause")
  })

  it("settles once every batch is sent, then follows the rest without a prompt or a send", async () => {
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo(null)
    await move()
    expect(operation()?.state).toBe("settled")
    // A late batch the observe pass sends again waits its turn, as a background step.
    expect(h.runMetadata).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ observeOnly: true, exclusive: expect.any(Function) }),
    )
  })

  it("keeps a stop after the hand-off in the bell, until the run moves on", async () => {
    prepares()
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
    await continueStopped()
    expect(runRow()).toBeNull()
  })

  it("says why a waiting run waits, as no stop and not in the bell", async () => {
    const waitReason = "Price data is out of date. Try again later."
    h.runMetadata.mockImplementationOnce(
      async (_c: unknown, o: { onPrepared(): void; signal: AbortSignal }) => {
        o.onPrepared()
        snapshot = { phase: "waiting", plan: "p", waitReason }
        publish()
        return untilAborted(o.signal)
      },
    )
    await move()
    await act(async () => openMigrationDialog())
    const text = detectedModal()?.textContent
    expect(text).toContain(waitReason)
    expect(text).not.toContain("couldn't finish a step")
    expect(upgradeStatus()).toMatchObject({ state: "running", phase: "waiting" })
    expect(runRow()).toBeNull()
  })

  it("carries a waiting run on in the background at boot, funds only, with no Continue", async () => {
    boot({ phase: "waiting", plan: "p" })
    h.keyFor = (portal) => (portal === source.portal ? "migration-test" : "migration-none")
    runTo(null, false)
    await render()
    expect(h.runMetadata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ promptless: true }),
    )
    expect(h.metadataSession).toHaveBeenCalledWith(
      expect.objectContaining({ historic: source, recoveryOnly: true }),
    )
    expect(upgradeStatus().state).toBe("running")
    expect(continueButton()).toBeUndefined()
    expect(runRow()).toBeNull()
  })

  it("leaves a saved run whose source waits for its migration feature waiting, with no Continue", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "lists no migration route" })
    h.keyFor = (portal) => (portal === source.portal ? "migration-test" : "migration-none")
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [
        {
          ...incomplete,
          tuple: source,
          frozen: true,
          incomplete: false,
          balance: 5n * 10n ** 18n,
          awaitingFeature: true,
        },
      ],
      pendingWithdrawals: 0,
    })
    await render()
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(continueButton()).toBeUndefined()
    expect(button("Try again")).toBeDefined()
    expect(document.body.textContent).toContain(
      "$5.00 is on the old version and can upgrade once the new version is ready",
    )
    expect(document.body.textContent).not.toContain("lists no migration route")
    expect(upgradeStatus().state).not.toBe("stopped")
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
    expect(continueButton()).toBeDefined()
  })

  it("asks for an approval the run is missing", async () => {
    boot({ phase: "needsApproval", plan: "p" })
    await render()
    expect(continueButton()).toBeDefined()
  })

  it("continues approvals a saved plan's refused prompt left", async () => {
    boot({ phase: "needsAttention", plan: "p", approvals: { approved: 1, total: 3 } })
    await render()
    expect(continueButton()).toBeDefined()
  })

  it("keeps a stop in the bell while the scan after it is still running", async () => {
    prepares()
    runTo({ phase: "needsAttention", plan: "p", error: "The relayer is down" })
    await render()
    h.probe.mockImplementation(() => new Promise(() => {}))
    await startUpgrade()
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
    await startUpgrade()
    expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
    expect(continueButton()?.disabled).toBe(false)
  })

  it("stops offering a resumed run once a scan finds its source waiting for its migration feature", async () => {
    boot({ phase: "needsApproval", plan: "p" })
    await render()
    runTo({ phase: "needsAttention", plan: "p", error: "lists no migration route" }, false)
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [
        {
          ...incomplete,
          tuple: source,
          frozen: true,
          incomplete: false,
          balance: 5n * 10n ** 18n,
          awaitingFeature: true,
        },
      ],
      pendingWithdrawals: 0,
    })
    await continueStopped()
    expect(document.body.textContent).toContain(
      "$5.00 is on the old version and can upgrade once the new version is ready",
    )
    expect(document.body.textContent).not.toContain("lists no migration route")
    expect(continueButton()).toBeUndefined()
    expect(upgradeStatus().state).not.toBe("stopped")
  })

  it("hands a resumed frozen run to the bell once its old version holds nothing more", async () => {
    boot({ phase: "recovering", plan: JSON.stringify({ sourceState: "frozen" }) })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [],
      pendingWithdrawals: 0,
    })
    runTo(null)
    await render()
    await continueStopped()
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(operation()?.handedOffAt).toBeDefined()
  })

  it("quotes only once the latest run's scan answers, when runs and their scans overlap", async () => {
    await render()
    const inventory = await h.probe.mock.results[0]!.value
    const scans: ((found: unknown) => void)[] = []
    h.probe.mockImplementation(() => new Promise((resolve) => scans.push(resolve)))
    runTo({ phase: "needsAttention", plan: "p", error: "first" }, false)
    await startUpgrade()
    runTo({ phase: "needsAttention", plan: "p", error: "second" }, false)
    await continueStopped()
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
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo({ phase: "done", plan: "p" }, false)
    await move()
    expect(detectedModal()?.textContent).toContain("Upgrade complete")
    await act(async () => button("Go to wallet")!.click())
    expect(detectedModal()?.textContent).not.toContain("Upgrade complete")
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).not.toContain("network fees")
    expect(detectedModal()?.textContent).toContain(passkeyTimes(3))
  })

  it("never offers a finished run's source again from the quote taken before it", async () => {
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo({ phase: "done", plan: "p" }, false)
    await render()
    h.probe.mockImplementation(() => new Promise(() => {}))
    await startUpgrade()
    expect(upgradeStatus().state).not.toBe("offered")
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
          <MemoryRouter>
            <MigrationDetectionMount />
          </MemoryRouter>
          <Offer />
        </QueryClientProvider>,
      )
    })
    await act(async () => openMigrationDialog())
    expect(offered()).toBe(true)
    await startUpgrade()
    expect(offered()).toBe(false)
  })

  it("never asks a saved run to fund its own upgrade", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x" })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()?.textContent).toContain("Something went wrong")
    expect(detectedModal()?.textContent).not.toContain("fund the upgrade yourself")
  })

  it("shows S1 on every launch, and Start again opens 2 Sign", async () => {
    boot({ phase: "preparing", draft: "d" })
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
    await act(async () => button("Start again")!.click())
    expect(detectedModal()?.textContent).toContain("Move your funds")
    act(() => root.unmount())
    root = createRoot(container)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
  })

  it("stops the run on Stop upgrade after S1 starts it again", async () => {
    boot({ phase: "preparing", draft: "d" })
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        await o.beforeApproval?.(0, 2)
        await o.beforeApproval?.(1, 2)
        return null
      },
    )
    await render({ request: false })
    expect(button("Withdraw funds instead")).toBeUndefined()
    await continueStopped()
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    await act(async () => button("Stop upgrade")!.click())
    expect(detectedModal()?.textContent).not.toContain("Leave upgrade?")
    expect(detectedModal()?.textContent).not.toContain("Upgrading...")
  })

  it("shows S2 for a run that sent funds, and Resume continues it", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x", fundsSent: true } as RunRecord)
    runTo(null)
    await render()
    expect(detectedModal()?.textContent).toContain("Finish your upgrade")
    expect(detectedModal()?.textContent).toContain("Did not complete")
    expect(upgradeSteps()).toEqual([
      ["Update your account", "done"],
      ["Withdraw from old wallet", "done"],
      ["Deposit to new wallet", "active"],
    ])
    await act(async () => button("Resume")!.click())
    expect(h.runMetadata).toHaveBeenCalled()
    expect(detectedModal()?.textContent).not.toContain("Finish your upgrade")
  })

  it("opens a bug report from S3 for a run that sent no funds, and returns to S3 when it closes", async () => {
    // The record update moves no funds.
    boot({ phase: "needsAttention", plan: "p", error: "x", bootstrapTx: "0xb" } as RunRecord)
    await render()
    expect(detectedModal()?.textContent).toContain("Something went wrong")
    await act(async () => button("Contact support")!.click())
    expect(document.body.textContent).toContain("Report a bug")
    await act(async () => {
      document
        .querySelector('dialog[aria-label="Report a bug"], dialog')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(document.body.textContent).not.toContain("Report a bug")
    expect(detectedModal()?.textContent).toContain("Something went wrong")
  })

  it("says what stopped a run in the user's terms", async () => {
    boot({
      phase: "needsAttention",
      plan: "p",
      error: "Metadata state changed; prepare migration again",
    })
    await render()
    const text = detectedModal()?.textContent
    expect(text).toContain("What happenedA step could not finish")
    expect(text).not.toMatch(/migration|metadata/i)
  })

  // A live source is offered no more, but a run saved over one still resumes, inside the dialog. No
  // operation holds its tab, so the note asks to keep it until every batch is sent.
  it("resumes a run saved over a live source", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x" })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [{ ...incomplete, tuple: source, incomplete: false, balance: 20n * 10n ** 18n }],
      pendingWithdrawals: 0,
    })
    runTo(null, false)
    await render()
    await continueStopped()
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
    expect(detectedModal()).not.toBeNull()
    expect(operation()).toBeUndefined()
    expect(detectedModal()?.textContent).toContain("Keep zk.money open")
  })
})

describe("MigrationDetectionMount — the dialog opens only on request", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
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

  it("shows 1 Choose for a movable source, and opens 2 Sign only when asked", async () => {
    probe(source)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrade to keep using zk.money")
    expect(upgradeSheet()).toBeNull()
    expect(upgradeStatus()).toEqual({ state: "offered", registration: true })
    await act(async () => openMigrationDialog())
    expect(upgradeSheet()).not.toBeNull()
  })

  it("shows 1 Choose on every launch, and Withdraw leaves it for Withdraw", async () => {
    probe(source)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrade to keep using zk.money")
    await act(async () => button("Withdraw funds instead")!.click())
    expect(detectedModal()).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrade to keep using zk.money")
  })

  it("waits on 1 Choose until the network proves a checkpoint", async () => {
    h.networkReady = false
    probe(source)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrading until 13:00 UTC")
    expect(detectedModal()?.textContent).toContain("Waiting for network")
    expect(button("Upgrade now")!.disabled).toBe(true)
  })

  it("waits on an action's upgrade too until the network proves a checkpoint", async () => {
    h.networkReady = false
    probe(source)
    await render({ request: false })
    await act(async () => openMigrationDialog({ action: "send" }))
    expect(detectedModal()?.textContent).toContain("Upgrade to send")
    expect(upgradeButton()!.disabled).toBe(true)
  })

  it("goes from 1 Choose to 2 Sign, and a close returns to 1", async () => {
    probe(source)
    await render({ request: false })
    await act(async () => button("Upgrade now")!.click())
    expect(detectedModal()?.textContent).toContain("Move your funds")
    await closeSheet()
    expect(upgradeSheet()).toBeNull()
    expect(detectedModal()?.textContent).toContain("Upgrade to keep using zk.money")
  })

  it("titles the sheet for the action that asked for the upgrade", async () => {
    probe(source)
    await render({ request: false })
    await act(async () => openMigrationDialog({ action: "send" }))
    expect(detectedModal()?.textContent).toContain("Upgrade to send")
    expect(upgradeButton()).toBeDefined()
    await act(async () => button("Maybe later")!.click())
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Move your funds")
  })

  it("stops an action's upgrade from Cancel, without the action's sheet", async () => {
    probe(source)
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        await o.beforeApproval?.(0, 2)
        await o.beforeApproval?.(1, 2)
        return null
      },
    )
    await render({ request: false })
    const then = vi.fn()
    await act(async () => openMigrationDialog({ action: "send", then }))
    await act(async () => upgradeButton()!.click())
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    await act(async () => button("Cancel")!.click())
    await act(async () => button("Stop upgrade")!.click())
    expect(detectedModal()?.textContent).not.toContain("Upgrade to send")
    expect(then).not.toHaveBeenCalled()
  })

  it("stops an action's upgrade from Back, without the action's sheet", async () => {
    probe(source)
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        await o.beforeApproval?.(0, 2)
        await o.beforeApproval?.(1, 2)
        return null
      },
    )
    const then = vi.fn()
    await render({ request: false })
    await act(async () => openMigrationDialog({ action: "send", then }))
    await act(async () => upgradeButton()!.click())
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    await act(async () => button("Stop upgrade")!.click())
    expect(detectedModal()?.textContent).not.toContain("Upgrade to send")
    expect(then).not.toHaveBeenCalled()
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
          <MemoryRouter>
            <MigrationDetectionMount />
          </MemoryRouter>
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
    expect(upgradeButton()).toBeDefined()
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

  it("keeps a saved run that waits for the user on S1, the banner and the bell, not in a dialog", async () => {
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
      expect(dialog()).toBeNull()
      expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
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

  it("shows no error when the manifest can't be read at boot, and checks again soon", async () => {
    h.probe.mockRejectedValueOnce(new ManifestUnavailableError(new Error("fetch failed")))
    await render({ request: false })
    expect(upgradeStatus().state).toBe("checking")
    expect(runRow()).toBeNull()
    probe(source)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(upgradeStatus().state).toBe("offered")
  })

  it("keeps the last scan when a later probe can't read the manifest, and probes again soon", async () => {
    const live: HistoricResidualSummary = {
      ...incomplete,
      tuple: { ...incomplete.tuple, portal: "0x" + "0c".repeat(20) } as never,
      incomplete: false,
      awaitingFreeze: true,
      balance: 10n ** 18n,
    }
    probe(source, live)
    await render({ request: false })
    expect(upgradeStatus().state).toBe("offered")
    h.probe.mockRejectedValueOnce(new ManifestUnavailableError(new Error("fetch failed")))
    await act(async () => freeze.onFrozen())
    expect(upgradeStatus().state).toBe("offered")
    expect(runRow()).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.probe).toHaveBeenCalledTimes(3)
    expect(upgradeStatus().state).toBe("offered")
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
      expect(upgradeButton()).toBeUndefined()
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
    expect(upgradeButton()).toBeUndefined()
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
    accountMetadataRegistry: "0x" + "56".repeat(20),
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
          <MemoryRouter>
            <MigrationDetectionMount />
          </MemoryRouter>
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

  it("releases the v6 sync only from the probe that runs, through StrictMode's effect replay", async () => {
    const { upgradeFirst } = await import("../src/features/migration/upgradeFirst")
    const released = vi.spyOn(upgradeFirst, "probeAnswered")
    let answer = (_: unknown) => {}
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await act(async () => {
      root.render(
        <React.StrictMode>
          <QueryClientProvider client={client}>
            <MemoryRouter>
              <MigrationDetectionMount />
            </MemoryRouter>
          </QueryClientProvider>
        </React.StrictMode>,
      )
    })
    expect(released).not.toHaveBeenCalled()

    await act(async () => answer(null))

    expect(released).toHaveBeenCalledOnce()
  })

  describe("1 Choose while the check runs", () => {
    const choose = () => document.querySelector('[data-testid="cutover-choose"]')
    const splash = () => !!container.textContent?.includes("Loading zk.money")
    const card = () => document.querySelector('[data-testid="cutover-balance"]')!
    /** The total and both halves show their skeletons, not figures. */
    const loading = () =>
      card().querySelectorAll("[aria-hidden]").length === 3 && !/[$…]/.test(card().textContent!)
    const record = (amount: bigint) =>
      BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(funded.tuple.portal, "0xabc"),
        funded.tuple.l2Token,
        amount,
      )
    const found = { current, historic: [funded.tuple], residuals: [funded], pendingWithdrawals: 0 }
    const waiting = { ...funded, balance: 0n, waitingDeposits: 1, waitingAmount: 5n }
    /** Boots again with the probe still running. */
    async function reboot() {
      act(() => root.unmount())
      root = createRoot(container)
      let answer = (_: unknown) => {}
      h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
      await render({ request: false })
      return answer
    }
    afterEach(async () => {
      await record(0n)
      walletStorage.removeItem(`webwallet.upgradeMovesFunds/${BOOTED_PORTAL.toLowerCase()}/0xabc`)
    })

    it("stands in from boot when the last check offered funds to move, loading until it offers", async () => {
      withTokenService()
      session()
      await record(10n ** 18n)
      h.probe.mockResolvedValue(found)
      await render({ request: false })
      expect(upgradeStatus().state).toBe("offered")

      const answer = await reboot()

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).not.toBeNull()
      expect(loading()).toBe(true)
      expect(button("Upgrade now")!.disabled).toBe(true)
      expect(button("Withdraw funds instead")!.disabled).toBe(true)
      expect(choose()!.textContent).toContain("Preparing your upgrade")

      await act(async () => answer(found))

      expect(upgradeStatus().state).toBe("offered")
      expect(loading()).toBe(false)
      expect(card().textContent).toContain("$1.00")
      expect(choose()!.textContent).not.toContain("Preparing your upgrade")
      expect(button("Upgrade now")!.disabled).toBe(false)
      expect(button("Withdraw funds instead")!.disabled).toBe(false)
    })

    it("keeps the boot screen up until the account's L1 record answers", async () => {
      let stale = (_: boolean) => {}
      h.recordStale.mockReturnValue(new Promise((resolve) => (stale = resolve)))

      await reboot()

      expect(splash()).toBe(true)
      expect(document.body.dataset.booting).toBe("full")
      expect(document.body.dataset.bootCovers).toBe("")
      expect(choose()).toBeNull()

      await act(async () => stale(true))

      expect(splash()).toBe(false)
      expect(document.body.dataset.bootCovers).toBeUndefined()
      expect(choose()).not.toBeNull()
    })

    it("shows Home if the record misses its wait, and keeps Home when it answers late", async () => {
      let stale = (_: boolean) => {}
      h.recordStale.mockReturnValue(new Promise((resolve) => (stale = resolve)))
      await reboot()

      await act(async () => vi.advanceTimersByTimeAsync(RECORD_CHECK_WAIT_MS))
      expect(splash()).toBe(false)

      await act(async () => stale(true))
      expect(choose()).toBeNull()
    })

    it("keeps the boot screen up through a failed check until the record answers", async () => {
      let stale = (_: boolean) => {}
      h.recordStale.mockReturnValue(new Promise((resolve) => (stale = resolve)))
      act(() => root.unmount())
      root = createRoot(container)
      h.probe.mockRejectedValue(new Error("node unreachable"))

      await render({ request: false })

      expect(upgradeStatus().state).toBe("failed")
      expect(splash()).toBe(true)

      await act(async () => stale(true))

      expect(splash()).toBe(false)
      expect(choose()).toBeNull()
    })

    it("leaves Home up after a boot on Withdraw, and reports no request there", async () => {
      markUpgradeMovesFunds("0xabc", true)
      let go = (_: string) => {}
      function Nav() {
        go = useNavigate()
        return null
      }
      act(() => root.unmount())
      root = createRoot(container)
      h.probe.mockReturnValue(new Promise(() => {}))
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={["/withdraw"]}>
              <MigrationDetectionMount />
              <Nav />
            </MemoryRouter>
            <Status />
          </QueryClientProvider>,
        )
      })

      await act(async () => openMigrationDialog("residuals"))
      expect(h.event).not.toHaveBeenCalled()

      await act(async () => go("/"))
      expect(choose()).toBeNull()
    })

    it("leaves Home up after the new-version prompt", async () => {
      markUpgradeMovesFunds("0xabc", true)
      await reboot()
      expect(choose()).not.toBeNull()

      h.live.mockResolvedValue("0x" + "bb".repeat(20))
      await poll()
      expect(repointModal()).not.toBeNull()
      await act(async () => button("Later")!.click())

      expect(choose()).toBeNull()
    })

    it("stands in from boot over a released lock when the last check offered funds to move", async () => {
      walletStorage.setItem("webwallet.version/0xabc", BOOTED_PORTAL.toLowerCase())
      markUpgradeMovesFunds("0xabc", true)

      try {
        await reboot()

        expect(choose()).not.toBeNull()
      } finally {
        walletStorage.removeItem("webwallet.version/0xabc")
      }
    })

    it("leaves Home up through later checks once it steps aside", async () => {
      withTokenService()
      session()
      markUpgradeMovesFunds("0xabc", true)
      const answer = await reboot()
      await act(async () => answer({ ...found, residuals: [{ ...funded, awaitingFreeze: true }] }))
      expect(choose()).toBeNull()

      quote.mockImplementationOnce(() => new Promise(() => {}))
      h.probe.mockResolvedValue(found)
      await act(async () => freeze.onFrozen())

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()
    })

    it("reports a dialog request made while it shows, and stays up", async () => {
      markUpgradeMovesFunds("0xabc", true)
      await reboot()

      await act(async () => openMigrationDialog("residuals"))

      expect(h.event).toHaveBeenCalledWith("action_failed", {
        action: "upgrade:open",
        code: "unknown",
      })
      expect(choose()).not.toBeNull()
    })

    it("leaves Home up through the check when boot chose Home, then offers what the probe found", async () => {
      withTokenService()
      session()
      let quoted = () => {}
      quote.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            quoted = () => resolve({ movable: 10n ** 18n, stranded: 0n, waiting: 0n })
          }),
      )
      h.probe.mockResolvedValue(found)

      await render({ request: false })

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()

      await act(async () => quoted())

      expect(upgradeStatus().state).toBe("offered")
      expect(choose()).not.toBeNull()
    })

    it("shows the probe's figure while it reads what moves, when a stale record chose it", async () => {
      withTokenService()
      session()
      h.recordStale.mockResolvedValue(true)
      let quoted = () => {}
      quote.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            quoted = () => resolve({ movable: 10n ** 18n, stranded: 0n, waiting: 0n })
          }),
      )
      h.probe.mockResolvedValue(found)

      await render({ request: false })

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).not.toBeNull()
      expect(loading()).toBe(false)
      expect(card().textContent).toContain("$1.00")
      expect(button("Upgrade now")!.disabled).toBe(true)
      expect(button("Withdraw funds instead")!.disabled).toBe(true)

      await act(async () => quoted())

      expect(upgradeStatus().state).toBe("offered")
      expect(button("Upgrade now")!.disabled).toBe(false)
    })

    it("leaves deposits still waiting out of the probe's figure", async () => {
      withTokenService()
      session()
      h.recordStale.mockResolvedValue(true)
      quote.mockImplementationOnce(() => new Promise(() => {}))
      h.probe.mockResolvedValue({
        ...found,
        residuals: [{ ...funded, waitingDeposits: 1, waitingAmount: 10n ** 18n }],
      })

      await render({ request: false })

      expect(choose()).not.toBeNull()
      expect(card().textContent).toContain("$1.00")
    })

    it("leaves Home up from boot when the last check found only funds no upgrade moves", async () => {
      withTokenService()
      session()
      await record(5n)
      h.probe.mockResolvedValue({ ...found, residuals: [waiting] })
      await render({ request: false })
      expect(upgradeStatus().state).not.toBe("offered")

      await reboot()

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()
    })

    it("stands in from boot when the account's L1 record still waits for the upgrade", async () => {
      withTokenService()
      session()
      h.recordStale.mockResolvedValue(true)

      const answer = await reboot()

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).not.toBeNull()
      expect(loading()).toBe(true)
      expect(button("Upgrade now")!.disabled).toBe(true)

      await act(async () => answer(found))

      expect(upgradeStatus().state).toBe("offered")
      expect(loading()).toBe(false)
    })

    it("gives Home back when the probe finds nothing to move behind a stale record", async () => {
      h.recordStale.mockResolvedValue(true)

      const answer = await reboot()
      expect(choose()).not.toBeNull()

      await act(async () => answer({ ...found, historic: [], residuals: [] }))

      expect(choose()).toBeNull()
    })

    it("decides boot by this browser's last answer, not a stale record", async () => {
      const { upgradeFirst } = await import("../src/features/migration/upgradeFirst")
      const order = vi.spyOn(upgradeFirst, "recordChecked")
      walletStorage.setItem(`webwallet.upgradeMovesFunds/${BOOTED_PORTAL.toLowerCase()}/0xabc`, "0")
      h.recordStale.mockResolvedValue(true)

      await reboot()

      expect(order.mock.calls[0]).toEqual([false])
    })

    it("leaves Home up behind a stale record once a check here offered only the record update", async () => {
      h.recordStale.mockResolvedValue(true)
      withTokenService()
      h.metadataSession.mockResolvedValue({
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: { needsMigration: async () => true, consentApprovals: async () => 1 },
      })
      h.probe.mockResolvedValue({ ...found, historic: [], residuals: [] })
      await render({ request: false })
      expect(upgradeStatus().state).toBe("offered")
      expect(choose()).toBeNull()

      await reboot()

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()
    })

    it("leaves Home up from boot with no check answered before and a current record", async () => {
      await record(10n ** 18n)

      await reboot()

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()
    })

    it("leaves Home up from boot once an upgrade has started", async () => {
      withTokenService()
      session()
      h.probe.mockResolvedValue(found)
      await render({ request: false })
      await acquireUpgradeLock("0xabc", 10n ** 18n)

      try {
        await reboot()

        expect(choose()).toBeNull()
      } finally {
        walletStorage.removeItem("webwallet.upgradeLock/0xabc")
      }
    })

    it("leaves Home up while the manifest can't be read at boot", async () => {
      withTokenService()
      session()
      h.probe.mockResolvedValue(found)
      await render({ request: false })
      act(() => root.unmount())
      root = createRoot(container)
      h.probe.mockRejectedValue(new ManifestUnavailableError("down"))

      await render({ request: false })

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()
    })

    it("leaves Home up while a later check can't read the manifest", async () => {
      withTokenService()
      h.metadataSession.mockRejectedValue(new ManifestUnavailableError("down"))
      h.probe.mockResolvedValue(found)

      await render({ request: false })

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()
    })

    it("leaves Home up when the probe finds nothing an upgrade moves", async () => {
      withTokenService()
      session()
      h.probe.mockResolvedValue({ ...found, residuals: [waiting] })

      await render({ request: false })

      expect(upgradeStatus().state).not.toBe("offered")
      expect(choose()).toBeNull()
    })
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
    expect(text).toContain("Old version fee ~$0.10")
    expect(text).toContain("New version fee ~$0.30")
    expect(text).toContain("You'll receive ~$84.60")
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
    expect(upgradeButton()?.disabled).toBe(false)
  })

  it("shows the working beat until the passkey signs, then closes as the burn runs", async () => {
    let finish!: (record: unknown) => void
    h.migrate.mockImplementation(
      asOperation(() => new Promise((resolve) => (finish = resolve)), "migration"),
    )
    await render()
    await startUpgrade()
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
    await startUpgrade()
    expect(detectedModal()?.textContent).toContain("Publishing your new address")
    await act(async () => published())
    expect(detectedModal()?.textContent).toContain("Preparing transaction…")
    await act(async () => finish({ localId: "w1" }))
  })

  it("reports a failure on the prompt, but not a closed passkey prompt", async () => {
    h.migrate.mockRejectedValueOnce(new Error("fee floor moved"))
    await render()
    await startUpgrade()
    expect(showReportableError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fee floor moved" }),
      "migration:intra-rollup",
    )
    expect(upgradeButton()).toBeDefined()

    vi.mocked(showReportableError).mockClear()
    h.migrate.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }))
    await startUpgrade()
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("leaves a failure after the hand-off to the record's rows", async () => {
    let fail!: (err: Error) => void
    h.migrate.mockImplementation(
      asOperation(() => new Promise((_, reject) => (fail = reject)), "migration"),
    )
    await render()
    await startUpgrade()
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
    accountMetadataRegistry: "0x" + "56".repeat(20),
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

  it.each([false, true])("holds Main (already current: %s)", async (alreadyCurrent) => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    if (alreadyCurrent)
      walletStorage.setItem("webwallet.version/0xabc", BOOTED_PORTAL.toLowerCase())
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
    await startUpgrade()

    // $2 live and $20.50 on the old version, less $1.50 in fees, $0.30 too small to move and $0.20
    // still waiting on the old network.
    expect(atStart).toEqual({ state: "held", main: 205n * 10n ** 17n })
  })

  it.each([false, true])(
    "holds Main and Savings separately (already current: %s)",
    async (alreadyCurrent) => {
      const wad = 10n ** 18n
      const savingsSource = {
        ...source,
        tuple: { ...source.tuple, portal: "0x" + "04".repeat(20) },
        balance: 50n * wad,
      }
      const savingsDestination = { ...current, portal: "0x" + "05".repeat(20) }
      walletStorage.setItem(
        "webwallet.identity",
        JSON.stringify({ address: "0xabc", claimedAt: 0 }),
      )
      if (alreadyCurrent)
        walletStorage.setItem("webwallet.version/0xabc", BOOTED_PORTAL.toLowerCase())
      markOldHoldingsRead("0xabc")
      h.balance = { walletBalance: "2.00", balanceKnown: true }
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(source.tuple.portal, "0xabc"),
        source.tuple.l2Token,
        20n * wad,
      )
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(savingsSource.tuple.portal, "0xabc"),
        savingsSource.tuple.l2Token,
        60n * wad,
      )
      withTokenService()
      h.tokenCreate.mockResolvedValue("savings-token-service")
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: {
          quote: async () => ({
            movable: historic.portal === savingsSource.tuple.portal ? 45n * wad : 19n * wad,
            fees: historic.portal === savingsSource.tuple.portal ? 5n * wad : wad,
            stranded: 0n,
            waiting: 0n,
            approvals: 1,
          }),
          needsMigration: () => needed,
        },
        holdings: async () => true,
      }))
      h.probe.mockResolvedValue({
        current,
        historic: [source.tuple, savingsSource.tuple],
        destinations: new Map([
          [source.tuple.portal.toLowerCase(), { tuple: current, symbol: "DAI" }],
          [
            savingsSource.tuple.portal.toLowerCase(),
            { tuple: savingsDestination, symbol: "sUSDS" },
          ],
        ]),
        residuals: [source, savingsSource],
        pendingWithdrawals: 0,
      })
      let atStart: unknown
      h.runMetadata.mockImplementation(async () => {
        atStart = lock()
        return null
      })
      await render()
      expect(upgradeButton()!.disabled).toBe(true)
      expect(h.runMetadata).not.toHaveBeenCalled()
      h.savings.position = { value: 3n * wad }
      await render()
      await startUpgrade()

      // Main: 2 + 20 - 1. Savings: 3 + 60 - (5 shares at 1.2 DAI).
      expect(atStart).toEqual({ state: "held", main: 21n * wad, savings: 57n * wad })
      await act(async () =>
        BalanceStorage.get(webStorage).updateBalance(
          oldVersionScope(savingsSource.tuple.portal, "0xabc"),
          savingsSource.tuple.l2Token,
          0n,
        ),
      )
    },
  )

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
    await act(async () => upgradeButton()!.click())
    expect(upgradeButton()!.disabled).toBe(true)
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(lock()).toEqual({ state: "pending" })

    h.balance = { walletBalance: "2.00", balanceKnown: true }
    await render()
    await startUpgrade()
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
