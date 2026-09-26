import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HistoricResidualSummary } from "../src/features/migration/historicResiduals"
import { provingProgress } from "@obsidion/proving-progress"
import { asOperation, endSigningAndHandOff } from "./support/handOff"
import { startTabBoundOperation } from "./support/operations"

const BOOTED_PORTAL = "0x" + "AA".repeat(20)

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  reconcile: vi.fn(),
  live: vi.fn(),
  aztec: { obsidionWallet: {} },
  account: { obsidionAccount: {} },
  asset: { current: { tokenService: undefined as unknown, loadAssets: async () => {} } },
  contracts: { contractService: {} },
  migrate: vi.fn(),
  fee: vi.fn(),
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
    useContractServiceContext: () => h.contracts,
    checkSpentViaPaylinkService: () => async () => new Map(),
    AppNotificationStore: { get: () => notes.store },
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
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { portal: "0x" + "AA".repeat(20) } }),
  fetchLiveProfilePortal: h.live,
}))
vi.mock("../src/features/migration/probeAccountResiduals", () => ({
  probeAccountResiduals: h.probe,
  reconcilePendingPaylinks: h.reconcile,
}))
vi.mock("../src/features/migration/runIntraRollupMigration", () => ({
  runIntraRollupMigration: h.migrate,
}))
vi.mock("../src/features/migration/migrationFee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/migration/migrationFee")>()),
  loadMigrationFee: h.fee,
}))

const { showReportableError } = await import("../src/errors/errorModal")
const { getOperationStore, runOperation } = await import("../src/features/operations/operations")
const upsert = vi.spyOn(notes.store, "upsert")
const dismiss = vi.spyOn(notes.store, "dismiss")
const residualsRow = () => notes.store.get("migration:residuals")
const { MigrationDetectionMount, PROFILE_REPOINT_POLL_MS } = await import(
  "../src/features/migration/MigrationDetectionMount"
)

const incomplete: HistoricResidualSummary = {
  tuple: { portal: "0x" + "01".repeat(20), l2Token: "0x" + "01".repeat(32) } as never,
  balance: 0n,
  sweptDeposits: 0,
  inTransitDeposits: 0,
  paylinkEscrows: 0,
  lockedPaylinks: [],
  paylinkCandidates: [],
  incomplete: true,
  hasResiduals: true,
}

let container: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
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

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MigrationDetectionMount />
      </QueryClientProvider>,
    )
  })
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
    expect(detectedModal()?.textContent).toContain("Move your funds")
    expect(detectedModal()?.textContent).toContain("About an hour, hands-off")
    expect(detectedModal()?.textContent).toContain("$85.00")
    expect(detectedModal()?.textContent).toContain("1 deposit(s) in transit")
    await act(async () => button("Later")!.click())
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
    expect(button("Move funds")?.disabled).toBe(false)
  })

  it("shows the working beat until the passkey signs, then closes as the burn runs", async () => {
    let finish!: (record: unknown) => void
    h.migrate.mockImplementation(
      asOperation(() => new Promise((resolve) => (finish = resolve)), "migration"),
    )
    await render()
    await act(async () => button("Move funds")!.click())
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
    await act(async () => button("Move funds")!.click())
    expect(detectedModal()?.textContent).toContain("Publishing your new address")
    await act(async () => published())
    expect(detectedModal()?.textContent).toContain("Preparing transaction…")
    await act(async () => finish({ localId: "w1" }))
  })

  it("reports a failure on the prompt, but not a closed passkey prompt", async () => {
    h.migrate.mockRejectedValueOnce(new Error("fee floor moved"))
    await render()
    await act(async () => button("Move funds")!.click())
    expect(showReportableError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fee floor moved" }),
      "migration:intra-rollup",
    )
    expect(button("Move funds")).toBeDefined()

    vi.mocked(showReportableError).mockClear()
    h.migrate.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }))
    await act(async () => button("Move funds")!.click())
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("leaves a failure after the hand-off to the record's rows", async () => {
    let fail!: (err: Error) => void
    h.migrate.mockImplementation(
      asOperation(() => new Promise((_, reject) => (fail = reject)), "migration"),
    )
    await render()
    await act(async () => button("Move funds")!.click())
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

  it("retires the residuals row once a complete scan finds nothing left", async () => {
    h.probe.mockResolvedValue({ current: withBalance.tuple, residuals: [], pendingWithdrawals: 0 })
    await render()
    expect(dismiss).toHaveBeenCalledWith("migration:residuals")
    expect(upsert).not.toHaveBeenCalled()
  })

  it("keeps the residuals row while the wallet is locked, which reads nothing", async () => {
    h.probe.mockResolvedValue(null)
    await render()
    expect(dismiss).not.toHaveBeenCalled()
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
    expect(dismiss).not.toHaveBeenCalled()
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
