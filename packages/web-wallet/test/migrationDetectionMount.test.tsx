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

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  reconcile: vi.fn(),
  live: vi.fn(),
  metadataSession: vi.fn(),
  runMetadata: vi.fn(),
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
    bootPriority: { whenBalanceSettled: async () => {} },
    checkSpentViaPaylinkService: () => async () => new Map(),
    AppNotificationStore: { get: () => notes.store },
    runMetadataMigration: h.runMetadata,
    metadataMigrationPhaseLabel: { awaitingMessages: "Waiting for your deposit and sponsorship" },
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
vi.mock("../src/features/migration/createWebMetadataMigration", () => ({
  createWebMetadataMigration: h.metadataSession,
  webMetadataMigrationKey: () => "migration-test",
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
const { getOperationStore, runOperation } = await import("../src/features/operations/operations")
const upsert = vi.spyOn(notes.store, "upsert")
const dismiss = vi.spyOn(notes.store, "dismiss")
const remove = vi.spyOn(notes.store, "remove")
const residualsRow = () => notes.store.get("migration:residuals")
const { MigrationDetectionMount, PROFILE_REPOINT_POLL_MS } = await import(
  "../src/features/migration/MigrationDetectionMount"
)
const { openMigrationDialog, useRegistrationMigrationNeeded } = await import(
  "../src/features/migration/migrationDialog"
)

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

describe("MigrationDetectionMount — metadata external funding", () => {
  it("shows the prepared address, exact fee and positive-deposit minimum after publication", async () => {
    withTokenService()
    const record = { plan: "signed-plan", phase: "awaitingMessages" }
    let publish = () => {}
    const controller = {
      load: async () => {},
      getSnapshot: () => record,
      subscribe: (listener: () => void) => {
        publish = listener
        return () => {}
      },
    }
    h.metadataSession.mockResolvedValue({
      controller,
      service: {
        needsMigration: async () => true,
        funding: async () => ({
          address: "0x" + "12".repeat(20),
          token: "0x" + "34".repeat(20),
          fee: 500_000_000_000_000_000n,
          minimumAmount: 500_000_000_000_000_001n,
          symbol: "DAI",
          decimals: 18,
          external: true,
        }),
      },
    })
    h.runMetadata.mockImplementation(async (_controller, { onProgress }) => {
      publish()
      await onProgress()
      return record
    })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, updateMetadataSIPAImplementation: "0x" + "56".repeat(20) },
      historic: [],
      residuals: [],
      pendingWithdrawals: 0,
    })
    await render()
    expect(h.runMetadata).not.toHaveBeenCalled()
    await act(async () => {
      ;[...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Migrate")!
        .click()
    })
    expect(container.textContent).toContain("0.500000000000000001 DAI")
    expect(container.textContent).toContain("settlement fee is 0.5 DAI")
    expect(container.textContent).toContain("0x" + "12".repeat(20))
    expect(container.textContent).toContain("0x" + "34".repeat(20))
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
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

  it("quotes a source holding only deposits at what its refunds move", async () => {
    withTokenService()
    session({ movable: 20n * 10n ** 18n })
    probe(frozen({ sweptDeposits: 2 }))
    await render()
    expect(detectedModal()?.textContent).toContain("$20.00 sits on a retired version")
    expect(detectedModal()?.textContent).toContain("Amount $20.00")
    expect(detectedModal()?.textContent).not.toContain("Also there")
    expect(button("Move funds")).toBeDefined()
  })

  it("adds the refunds a run takes to the notes, and names what no batch can afford", async () => {
    withTokenService()
    session({ movable: 30n * 10n ** 18n, stranded: 3n * 10n ** 17n })
    probe(frozen({ balance: 10n * 10n ** 18n, sweptDeposits: 2 }))
    await render()
    expect(detectedModal()?.textContent).toContain("Amount $30.00")
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
    async function resume(phase: string, quotes: { a: bigint; b: bigint }) {
      withTokenService()
      const calls: Array<[string, boolean | undefined]> = []
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: {
          quote: async (opts: { firstBatchSettled?: boolean }) => {
            const which = historic.portal === a.portal ? "a" : "b"
            calls.push([which, opts.firstBatchSettled])
            return { movable: quotes[which] * DAI, stranded: 0n, waiting: 0n }
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
      expect(detectedModal()?.textContent).toContain("Amount $50.00")
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
      const quotes = { a: 30n, b: 50n }
      const { record } = await resume("recovering", quotes)
      expect(detectedModal()?.textContent).toContain("Amount $50.00")
      // The run's first refund executes before it stops.
      quotes.b = 20n
      h.runMetadata.mockResolvedValue(record)
      await act(async () => button("Continue migration")!.click())
      expect(detectedModal()?.textContent).toContain("Amount $20.00")
    })
  })

  it("takes a quoted source's waiting deposits from its quote", async () => {
    withTokenService()
    session({ movable: 40n * 10n ** 18n })
    probe(
      frozen({ balance: 30n * 10n ** 18n, waitingDeposits: 1, waitingAmount: 10n * 10n ** 18n }),
    )
    await render()
    expect(detectedModal()?.textContent).toContain("Amount $40.00")
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
    await render()
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
    expect(button("Move funds")).toBeDefined()
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
    detectedModal()?.textContent?.includes("Update your wallet registration")
  let flag: () => boolean
  function Flag() {
    const needed = useRegistrationMigrationNeeded()
    flag = () => needed
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
  }

  it("asks for the registration update when the retired version holds nothing", async () => {
    probe()
    await renderWithFlag()
    expect(registrationPrompt()).toBe(true)
    expect(button("Migrate")).toBeDefined()
    expect(sessionFor).toHaveBeenCalledWith(current.portal)
    expect(flag()).toBe(true)
  })

  it("asks for it when a live balance can't pay its own exit", async () => {
    stranded = 10n ** 17n
    probe(live({ balance: 10n ** 17n }))
    await render()
    expect(movable).toHaveBeenCalledTimes(1)
    expect(registrationPrompt()).toBe(true)
    expect(residualsRow()).toMatchObject({ description: "$0.10 too small to move" })
  })

  it("never reads a failed probe or movability check as nothing to move", async () => {
    probe(incomplete)
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    probe(live({ balance: 10n ** 17n }))
    movable.mockRejectedValue(new Error("source node down"))
    await act(async () => retryButton()!.click())
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    expect(needsMigration).not.toHaveBeenCalled()
  })

  it("waits for a retry's own movability before asking", async () => {
    probe(incomplete, live({ balance: 10n ** 17n }))
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    let settle!: (movable: boolean) => void
    movable.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
    probe(live({ balance: 85n * 10n ** 18n }))
    await act(async () => retryButton()!.click())
    expect(needsMigration).not.toHaveBeenCalled()
    expect(registrationPrompt()).toBeFalsy()
    await act(async () => settle(true))
    expect(detectedModal()?.textContent).toContain("Move your funds")
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
    probe(live({ balance: 85n * 10n ** 18n, ...transit }))
    await render()
    expect(detectedModal()?.textContent).toContain("Also there: $10.00 in transit")
    // The deposit arrives while the run is paused.
    probe(live({ balance: 95n * 10n ** 18n }))
    h.runMetadata.mockResolvedValue({ plan: "signed-plan", phase: "recovering" })
    await act(async () => button("Move funds")!.click())
    expect(detectedModal()?.textContent).not.toContain("in transit")
  })

  it("moves a movable source rather than starting the registration-only session", async () => {
    movable.mockResolvedValue(true)
    probe(live({ balance: 85n * 10n ** 18n }))
    await render()
    expect(detectedModal()?.textContent).toContain("Move your funds")
    await act(async () => button("Move funds")!.click())
    expect(needsMigration).not.toHaveBeenCalled()
    expect(sessionFor).not.toHaveBeenCalledWith(current.portal)
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
  })

  it("reopens on request after Later", async () => {
    probe()
    await render()
    await act(async () => button("Later")!.click())
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
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Migrate",
    )!
    await act(async () => {
      button.click()
      button.click()
    })
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
    expect(h.runMetadata).toHaveBeenCalledWith(
      controller,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain("Waiting for your deposit and sponsorship")
    await act(async () => finish())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Destination registry changed",
    )
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe("Continue migration")
    await act(async () => button.click())
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
      expect(button("Continue migration")).toBeDefined()
      expect(h.runMetadata).not.toHaveBeenCalled()
      await act(async () => button("Continue migration")!.click())
      expect(h.runMetadata).toHaveBeenCalledTimes(1)
    } finally {
      saved.mockRestore()
    }
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
    expect(remove).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
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
