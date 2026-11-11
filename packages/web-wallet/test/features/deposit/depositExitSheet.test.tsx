/** Guards: exits and recovery stay offered, screening blocks both, one sweep, recovery stays. */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import {
  passThroughScreener,
  ScreeningProvider,
  type AddressScreener,
  type PendingRegistrationRecord,
  type SipaDeposit,
} from "@obsidion/front-core"
import type { Address, Hex } from "viem"
import { sepolia } from "viem/chains"
import { useWalletPrompt } from "../../../src/session/walletPrompt"
import * as copy from "../../../src/features/limits/limitsCopy"
import errorWords from "../../../src/errors/catalog.copy"
import { testScreenings } from "../../support/page"

const EXPLORER = "https://sepolia.etherscan.io"
const SWEEP_HASH = `0x${"5e".repeat(32)}` as Hex

const h = vi.hoisted(() => ({
  fireEvent: vi.fn(),
  selfSweep: vi.fn(),
  manualRegistrationSweep: vi.fn(),
  readStrandedToken: vi.fn(),
  reusePasskeyAccount: vi.fn(),
  showReportableError: vi.fn(),
  // Swapped per describe: undefined for the plain-deposit tests, truthy for the registration ones.
  wallet: { current: undefined as unknown },
  processing: { current: undefined as unknown },
  retry: vi.fn(async (_sipa: string) => undefined),
  capacityKey: { current: undefined as unknown },
  /** One observer object, like the production singleton. */
  observer: { retry: (sipa: string) => h.retry(sipa) },
}))

vi.mock("../../../src/features/sipa/sipaSweep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/sipa/sipaSweep")>()),
  selfSweep: h.selfSweep,
}))
vi.mock("../../../src/features/deposit/recovery/sipaRecovery", () => ({
  recoverDeposit: vi.fn(),
  readStrandedToken: h.readStrandedToken,
}))
vi.mock("../../../src/features/deposit/sipaProcessing", () => ({
  // Every deposit here is past the stuck clock, so what gates the sweep is also what the sheet states.
  useSipaProcessing: () => ({
    state: h.processing.current,
    shown: h.processing.current,
    capacityKey: h.capacityKey.current,
  }),
}))
// About limits reads its bucket from the shared registry; these fake stores record which bucket was asked for.
const capacity = vi.hoisted(() => ({
  availableAtomic: 700n * 10n ** 18n,
  epoch: 0,
  keys: [] as string[],
}))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
// No table is read.
vi.mock("../../../src/features/sipa/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts } = await import("../../support/depositTokens")
  return mockLoadDepositFacts(importOriginal, () => undefined)
})
vi.mock("../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => 5166n * 10n ** 18n,
  useRowTxAmountCap: (rowToken?: string) => (rowToken ? 2_583n * 10n ** 18n : undefined),
}))
// The passkey helper drags the onboarding flow in; the registration tests only need its keys.
vi.mock("../../../src/features/identity/passkeyAccount", () => ({
  reusePasskeyAccount: h.reusePasskeyAccount,
}))
// Keep registrationRecordForSipa/canManualRegistrationSweep real — the seeded pending store is
// what drives the routing under test; only the L1-touching sweep itself is stubbed.
vi.mock("../../../src/features/registration/registrationSweep", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/features/registration/registrationSweep")
  >()),
  manualRegistrationSweep: h.manualRegistrationSweep,
}))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  failureCode: () => "x",
  lapTimer: () => () => 0,
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
const fakeAuth = () => ({ probePhoneReach: async () => "unknown", recordsStale: () => false })
// The DS drags in liquid-glass optics jsdom can't render; this test is about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      <span>{value}</span>
    </div>
  ),
  DoubleCheckIcon: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  GradientToggle: () => null,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    testId,
    isDisabled,
    onClick,
  }: {
    title: string
    testId?: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button data-testid={testId} disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ label }: { label: string }) => <div>{label}</div>,
  Spinner: () => null,
  TextField: ({
    label,
    value,
    onChange,
  }: {
    label: string
    value: string
    onChange: (v: string) => void
  }) => <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
  TopNavIconButton: () => null,
}))

const { DepositExitModal } = await import(
  "../../../src/features/deposit/DepositExitModal/DepositExitModal"
)
const { StrandedRecoveryModal } = await import(
  "../../../src/features/deposit/recovery/StrandedRecoveryModal/StrandedRecoveryModal"
)
const { SweepRefusedError } = await import("../../../src/features/sipa/sipaSweep")
const { seedRegistration } = await import("../../support/registrationFixtures")
const { closeSession } = await import("../../../src/session/session")
const support = await import("../../support/session")
const { fakeL1Wallet, withL1Wallet } = await import("../../support/fakeL1Wallet")
/** A session whose page has a wallet connected on the L1. */
const openTestSession = (...args: Parameters<typeof support.openTestSession>) => {
  const session = support.openTestSession(...args)
  const wallet = fakeL1Wallet()
  wallet.connect("0x00000000000000000000000000000000000000aa", session.page.config.l1ChainId)
  wallet.set({ walletName: null })
  withL1Wallet(session, wallet.wallet)
  return session
}
const { defaultConfig } = await import("../../support/page")
const config = { ...defaultConfig, l1ChainId: sepolia.id, l1Chain: sepolia }

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const STARTED_AT = Date.now() - (3 * 60 + 5) * 60_000

const stuck = {
  sipaAddress: "0x000000000000000000000000000000000000d0d0",
  recipientL2Address: `0x${"aa".repeat(32)}`,
  messageSecret: `0x${"01".repeat(32)}`,
  recipientHash: `0x${"02".repeat(32)}`,
  recoveryAddress: "0x000000000000000000000000000000000000b0b0",
  l1ChainId: 11155111,
  amount: "18",
  tokenSymbol: "DAI",
  phase: "sweeping",
  startTime: STARTED_AT,
} as SipaDeposit

beforeEach(
  () =>
    openTestSession({ config, auth: fakeAuth(), sipaProcessingObserver: h.observer }).registrations
      .ready,
)
afterEach(closeSession)

describe("DepositExitModal — stuck deposit", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  // The second act flushes the screening hook's zero-delay debounce timer.
  const render = async (screener: AddressScreener = passThroughScreener) => {
    await act(async () => {
      root.render(
        <ScreeningProvider screenings={testScreenings(screener)}>
          <DepositExitModal record={stuck} reason="stuck" canSweep onClose={vi.fn()} />
        </ScreeningProvider>,
      )
    })
    await act(() => new Promise((r) => setTimeout(r, 1)))
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.selfSweep.mockResolvedValue(SWEEP_HASH)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await render()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("returns to the form after wallet cancellation and allows retry", async () => {
    h.selfSweep.mockRejectedValueOnce({ code: 4001, message: "User rejected the request." })
    await act(async () => button("Sweep now")!.click())
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(button("Sweep now")!.disabled).toBe(false)
    expect(container.querySelector("a")).toBeNull()

    await act(async () => button("Sweep now")!.click())
    expect(h.selfSweep).toHaveBeenCalledTimes(2)
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`${EXPLORER}/tx/${SWEEP_HASH}`)
  })

  it("disables both exits while the paid address is screened out", async () => {
    await render({
      screen: async () => ({
        compliant: false,
        reason: { code: "blocked", message: "Address blocked" },
      }),
    })
    expect(container.textContent).toContain("Address blocked")
    expect(button("Sweep now")!.disabled).toBe(true)
    expect(button("Recover to an Ethereum address")!.disabled).toBe(true)
  })
})

describe("DepositExitModal — network capacity", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  const blocked = {
    reason: {
      kind: "capacity",
      requiredAtomic: 17n * 10n ** 18n,
      availableAtomic: 5n * 10n ** 18n,
      refill: { status: "unknown" },
      decimals: 18,
      observedAt: STARTED_AT,
    },
    blocker: { kind: "capacity", observedAt: STARTED_AT },
  }

  const render = async (props: { reason: "stuck" | "unsweepable" | null; canSweep: boolean }) => {
    await act(async () => {
      root.render(
        <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
          <DepositExitModal record={stuck} {...props} onClose={vi.fn()} />
        </ScreeningProvider>,
      )
    })
    await act(() => new Promise((r) => setTimeout(r, 1)))
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.selfSweep.mockResolvedValue(SWEEP_HASH)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    h.processing.current = undefined
    vi.clearAllMocks()
  })

  it("disables the sweep while capacity is confirmed short, and keeps recovery open", async () => {
    h.processing.current = blocked
    await render({ reason: "stuck", canSweep: true })
    const reason = container.querySelector('[data-testid="deposit-pending-reason"]')
    expect(reason?.textContent).toContain("Waiting for network capacity")
    expect(reason?.textContent).toContain("Your funds remain at your Ethereum deposit address.")
    // The amounts are in the reason's details, not repeated on the sheet.
    expect(reason?.textContent).not.toContain("This deposit needs")
    expect(button("Sweep now")!.disabled).toBe(true)
    expect(button("Recover to an Ethereum address")!.disabled).toBe(false)
    // The held action says why, and nothing beside it says it can be used.
    expect(container.querySelector('[data-testid="sweep-held"]')?.textContent).toBe(
      "Waiting for network capacity.",
    )
    expect(container.textContent).not.toContain("You can sweep it yourself")

    await act(async () => button("Check again")!.click())
    expect(h.retry).toHaveBeenCalledWith(stuck.sipaAddress)
    expect(h.selfSweep).not.toHaveBeenCalled()

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='deposit-pending-reason-help'] [data-testid='about-limits-link']",
        )!
        .click(),
    )
    const details = document.querySelector(
      `dialog[aria-label="${copy.SHEET_TITLE}"] [data-testid='about-limits-capacity']`,
    )
    // The settlement token comes from the deployment; this test's config names none.
    expect(details?.textContent).toMatch(
      /This deposit needs 17 (\w+); 5 \1 of network capacity is available now\./,
    )
  })

  describe("About limits beside the reason", () => {
    const ORIGINAL = {
      chainId: 11155111,
      portal: "0x9999999999999999999999999999999999999999",
      token: "0x2222222222222222222222222222222222222222",
    } as const
    const openSheet = async () => {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            "[data-testid='deposit-pending-reason-help'] [data-testid='about-limits-link']",
          )!
          .click(),
      )
      for (let i = 0; i < 5; i++) await act(async () => {})
      return () =>
        document.querySelector<HTMLElement>(
          `dialog[aria-label="${copy.SHEET_TITLE}"] [data-testid='about-limits-capacity']`,
        )!
    }
    const readActive = () =>
      capacity.keys.some((id) => id.includes("0x1111111111111111111111111111111111111111"))
    const readOriginal = () => capacity.keys.some((id) => id.includes(ORIGINAL.portal))

    beforeEach(() => {
      capacity.epoch += 1
      capacity.keys.length = 0
      vi.spyOn(console, "warn").mockImplementation(() => {})
    })
    afterEach(() => {
      h.capacityKey.current = undefined
    })

    it("retries a failed portal lookup through the observer and then shows the original bucket", async () => {
      h.processing.current = blocked
      h.capacityKey.current = { status: "unknown", retryable: true }
      await render({ reason: "stuck", canSweep: true })
      const section = await openSheet()
      expect(section().dataset.state).toBe("unavailable")
      expect(capacity.keys).toEqual([])
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>("[data-testid='about-limits-capacity-retry']")!
          .click(),
      )
      expect(h.retry).toHaveBeenCalledWith(stuck.sipaAddress)
      expect(readActive()).toBe(false)
      // The observer notifies once the lookup settles; the sheet then reads the original bucket.
      h.capacityKey.current = { status: "known", key: ORIGINAL }
      await render({ reason: "stuck", canSweep: true })
      for (let i = 0; i < 5; i++) await act(async () => {})
      expect(section().dataset.state).toBe("fresh")
      expect(readOriginal()).toBe(true)
      expect(readActive()).toBe(false)
    })

    it("offers no Retry when no lookup can name the bucket", async () => {
      h.processing.current = blocked
      h.capacityKey.current = { status: "unknown", retryable: false }
      await render({ reason: "stuck", canSweep: true })
      const section = await openSheet()
      expect(section().dataset.state).toBe("unavailable")
      expect(document.querySelector("[data-testid='about-limits-capacity-retry']")).toBeNull()
      expect(capacity.keys).toEqual([])
    })
  })

  it("keeps recovery open when capacity cannot be read", async () => {
    h.processing.current = { reason: { kind: "unavailable", cause: "capacity-unread" } }
    await render({ reason: "stuck", canSweep: true })
    expect(container.textContent).toContain("Reason unavailable")
    expect(button("Sweep now")!.disabled).toBe(false)
    expect(button("Recover to an Ethereum address")!.disabled).toBe(false)
  })

  it("shows a refused sweep beside the action instead of reporting a fault", async () => {
    h.selfSweep.mockRejectedValueOnce(new SweepRefusedError("sweep.capacity"))
    await render({ reason: "stuck", canSweep: true })
    await act(async () => button("Sweep now")!.click())
    expect(container.querySelector('[data-testid="deposit-sweep-refused"]')?.textContent).toBe(
      errorWords["sweep.capacity"],
    )
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(button("Recover to an Ethereum address")!.disabled).toBe(false)
  })

  it("hands a confirmed recovery's hash to the caller, and never a sweep's", async () => {
    const { recoverDeposit } = await import("../../../src/features/deposit/recovery/sipaRecovery")
    const recovery = `0x${"ab".repeat(32)}` as Hex
    vi.mocked(recoverDeposit).mockResolvedValueOnce(recovery)
    const onRecovered = vi.fn()
    const open = async (reason: "stuck" | "unsweepable", canSweep: boolean) => {
      await act(async () => {
        root.render(
          <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
            <DepositExitModal
              key={reason}
              record={stuck}
              reason={reason}
              canSweep={canSweep}
              onRecovered={onRecovered}
              onClose={vi.fn()}
            />
          </ScreeningProvider>,
        )
      })
      await act(() => new Promise((r) => setTimeout(r, 1)))
    }
    await open("stuck", true)
    await act(async () => button("Sweep now")!.click())
    expect(onRecovered).not.toHaveBeenCalled()
    await open("unsweepable", false)
    await act(async () => button("Recover to 0x00000…000AA")!.click())
    expect(onRecovered).toHaveBeenCalledTimes(1)
    expect(onRecovered).toHaveBeenCalledWith(recovery)
  })
})

describe("DepositExitModal — registration-backed deposit", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  const registration = (
    over: Partial<PendingRegistrationRecord> = {},
  ): PendingRegistrationRecord => ({
    account: ACCOUNT,
    tag: "alice",
    nameHash: `0x${"77".repeat(32)}` as Hex,
    l2Address: stuck.recipientL2Address as Hex,
    l1ChainId: 11155111,
    sipaAddress: stuck.sipaAddress,
    fee: "1",
    beneficiary: ACCOUNT,
    depositToken: "0x00000000000000000000000000000000000000d4" as Hex,
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    ...over,
  })

  const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address

  const render = async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
          <DepositExitModal record={stuck} reason="stuck" canSweep onClose={vi.fn()} />
        </ScreeningProvider>,
      )
    })
    await act(() => new Promise((r) => setTimeout(r, 1)))
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    h.wallet.current = {}
    await openTestSession({ config, auth: fakeAuth(), wallet: h.wallet.current }).registrations
      .ready
    h.reusePasskeyAccount.mockResolvedValue({ secretKey: "0x1" })
    h.manualRegistrationSweep.mockResolvedValue(SWEEP_HASH)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
    h.wallet.current = undefined
    vi.clearAllMocks()
  })

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))
  type GateResult = { signal: AbortSignal; reach: string }
  type Gate = () => Promise<GateResult>
  /** A recovery that waits at the gate the way the real one does. */
  const gatedRecovery = (then: () => unknown) =>
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _signIn: unknown, _a: unknown, _h: unknown, gate: Gate) => {
        await gate()
        return then()
      },
    )

  it("Cancel at the phone steps returns to the form with nothing reported", async () => {
    gatedRecovery(() => ({ secretKey: "0x1" }))
    await seedRegistration(registration())
    await render()
    await act(async () => button("Sweep now")!.click())
    await flush()
    await act(async () => byTestId("sign-in-cancel")!.click())
    await flush()
    expect(byTestId("sign-in-sheet")).toBeNull()
    expect(button("Sweep now")).toBeTruthy()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    expect(h.showReportableError).not.toHaveBeenCalled()
  })

  it("a policy refusal renders in place with a retry, never the report modal", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    gatedRecovery(() => {
      throw new PhoneRequiredError()
    })
    await seedRegistration(registration())
    await render()
    await act(async () => button("Sweep now")!.click())
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(byTestId("deposit-refused")?.dataset.reason).toBe("PhoneRequiredError")
    expect(byTestId("deposit-retry")).not.toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
  })

  it("a refusal another attempt cannot fix hides the sweep and offers no retry", async () => {
    const { RotatedCredentialError } = await import("@obsidion/passkey-web")
    gatedRecovery(() => {
      throw new RotatedCredentialError()
    })
    await seedRegistration(registration())
    await render()
    await act(async () => button("Sweep now")!.click())
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(byTestId("deposit-refused")?.dataset.reason).toBe("RotatedCredentialError")
    expect(byTestId("deposit-retry")).toBeNull()
    expect(button("Sweep now")).toBeUndefined()
  })

  it("stops before the passkey when the registration settled while the sheet was open", async () => {
    await seedRegistration(registration())
    await render()
    // The detection tick stamps the sweep after the sheet rendered its offer.
    await seedRegistration(registration({ sweepTxHash: SWEEP_HASH }))
    await act(async () => button("Sweep now")!.click())
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    expect(h.selfSweep).not.toHaveBeenCalled()
    expect(h.showReportableError).toHaveBeenCalledOnce()
  })
})
describe("DepositExitModal — opened from Recover", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    h.processing.current = undefined
    vi.clearAllMocks()
  })

  const render = async (sweepable?: boolean) => {
    await act(async () => {
      root.render(
        <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
          <DepositExitModal
            record={stuck}
            reason="stuck"
            canSweep={false}
            sweepable={sweepable}
            onClose={vi.fn()}
          />
        </ScreeningProvider>,
      )
    })
    await act(() => new Promise((r) => setTimeout(r, 1)))
  }

  const held = {
    reason: {
      kind: "capacity" as const,
      requiredAtomic: 17n * 10n ** 18n,
      availableAtomic: 5n * 10n ** 18n,
      refill: { status: "unknown" as const },
      decimals: 18,
      observedAt: STARTED_AT,
    },
    blocker: { kind: "capacity" as const, observedAt: STARTED_AT },
  }
  const cleared = {
    reason: {
      kind: "processing" as const,
      availableAtomic: 50n * 10n ** 18n,
      decimals: 18,
      observedAt: STARTED_AT + 1,
    },
  }

  it("offers the sweep once a read clears the blocker, and keeps recovery", async () => {
    h.processing.current = held
    await render(true)
    expect(button("Sweep now")).toBeUndefined()
    h.processing.current = cleared
    await render(true)
    expect(button("Sweep now")!.disabled).toBe(false)
    expect(button("Recover to an Ethereum address")!.disabled).toBe(false)
  })

  it("never offers the sweep on a sheet opened as recovery only", async () => {
    h.processing.current = cleared
    await render()
    expect(button("Sweep now")).toBeUndefined()
  })

  it("never offers the sweep without a live state, as for a settled deposit", async () => {
    await render(true)
    expect(button("Sweep now")).toBeUndefined()
  })

  it("keeps a recovery the user started from turning into a sweep", async () => {
    const { recoverDeposit } = await import("../../../src/features/deposit/recovery/sipaRecovery")
    vi.mocked(recoverDeposit).mockRejectedValueOnce(new Error("wallet unreachable"))
    h.processing.current = held
    await render(true)
    await act(async () => button("Recover to 0x00000…000AA")!.click())
    expect(recoverDeposit).toHaveBeenCalledOnce()
    h.processing.current = cleared
    await render(true)
    expect(button("Sweep now")).toBeUndefined()
    expect(button("Recover to 0x00000…000AA")).toBeDefined()
  })

  it("leads with recovery and states the capacity reason, with no sweep to wait on", async () => {
    h.processing.current = {
      reason: {
        kind: "capacity",
        requiredAtomic: 17n * 10n ** 18n,
        availableAtomic: 5n * 10n ** 18n,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: STARTED_AT,
      },
      blocker: { kind: "capacity", observedAt: STARTED_AT },
    }
    await render()
    expect(container.textContent).toContain("Recover deposit")
    expect(container.textContent).toContain("Waiting for network capacity")
    expect(container.textContent).toContain("a relayer may yet land it")
    expect(button("Sweep now")).toBeUndefined()
    // No sweep is offered, so nothing about it is either.
    for (const id of ["sweep-details", "sweep-held", "sweep-gas"]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBeNull()
    }
    expect(button("Recover to 0x00000…000AA")!.disabled).toBe(false)
    const { recoverDeposit } = await import("../../../src/features/deposit/recovery/sipaRecovery")
    await act(async () => button("Recover to 0x00000…000AA")!.click())
    expect(recoverDeposit).toHaveBeenCalledWith(stuck, expect.anything())
    expect(h.selfSweep).not.toHaveBeenCalled()
  })
})

/** The page-wide wallet slot, read as the sheets read it. */
function SlotProbe() {
  return <span data-testid="wallet-slot" data-open={String(useWalletPrompt().open)} />
}

describe("DepositExitModal waiting on the wallet", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)
  const note = () => container.querySelector<HTMLElement>('[data-testid="wallet-prompt-stall"]')
  const stall = () => act(async () => vi.advanceTimersByTime(30_000))
  const cancel = () => act(async () => note()!.querySelector("button")!.click())
  const slotOpen = () =>
    container.querySelector<HTMLElement>('[data-testid="wallet-slot"]')!.dataset.open
  /** A sweep the wallet holds at its prompt until the test answers for it. */
  const atPrompt = () => {
    const held = {} as {
      resolve: (hash: Hex) => void
      reject: (e: unknown) => void
      stage: (stage: string) => void
    }
    h.selfSweep.mockImplementationOnce(
      (_record: unknown, opts: { onStage: (stage: string) => void }) => {
        held.stage = opts.onStage
        opts.onStage("signing")
        return new Promise<Hex>((resolve, reject) => Object.assign(held, { resolve, reject }))
      },
    )
    return held
  }

  beforeEach(async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
          <DepositExitModal record={stuck} reason="stuck" canSweep onClose={vi.fn()} />
          <SlotProbe />
        </ScreeningProvider>,
      )
    })
    await act(() => new Promise((r) => setTimeout(r, 1)))
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("offers a way back after 30 seconds at the prompt, and a late rejection reports nothing", async () => {
    const held = atPrompt()
    await act(async () => button("Sweep now")!.click())
    expect(container.textContent).toContain("Approve the sweep in your wallet")
    await act(async () => vi.advanceTimersByTime(29_999))
    expect(note()).toBeNull()
    await act(async () => vi.advanceTimersByTime(1))
    expect(note()!.textContent).toContain("Still waiting for your wallet.")
    await cancel()
    expect(note()).toBeNull()
    expect(button("Sweep now")!.disabled).toBe(false)
    await act(async () => held.reject(new Error("wallet closed")))
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
    expect(button("Sweep now")!.disabled).toBe(false)
  })

  it("refuses a second sweep while the wallet holds the first, then lands its late hash", async () => {
    const held = atPrompt()
    await act(async () => button("Sweep now")!.click())
    await stall()
    await cancel()
    await act(async () => button("Sweep now")!.click())
    expect(h.selfSweep).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="deposit-sweep-refused"]')?.textContent).toBe(
      "Your wallet still has the previous request open. Approve or reject it there first.",
    )
    await act(async () => held.resolve(SWEEP_HASH))
    expect(container.textContent).toContain("Deposit on its way")
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`${EXPLORER}/tx/${SWEEP_HASH}`)
  })

  it("frees the slot once the sweep is confirming, before the receipt lands", async () => {
    const held = atPrompt()
    await act(async () => button("Sweep now")!.click())
    expect(slotOpen()).toBe("true")
    await act(async () => held.stage("confirming"))
    expect(slotOpen()).toBe("false")
    expect(button("Sweep now")).toBeUndefined()
  })
})

describe("StrandedRecoveryModal", () => {
  let container: HTMLDivElement
  let root: Root

  const type = (label: string, value: string) => {
    const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    await openTestSession({
      config,
      auth: fakeAuth(),
      wallet: { networkId: "0x00000000000000000000000000000000000000e1" },
    }).registrations.ready
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("opens the exit sheet for a token the lookup finds", async () => {
    h.readStrandedToken.mockResolvedValue({
      record: stuck,
      token: { address: "0x00000000000000000000000000000000000000d4", symbol: "DAI", decimals: 18 },
      balance: "7",
    })
    await act(async () =>
      root.render(
        <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
          <StrandedRecoveryModal onClose={vi.fn()} />
        </ScreeningProvider>,
      ),
    )
    await act(async () => {
      type("Deposit address", stuck.sipaAddress)
      type("Token address", "0x00000000000000000000000000000000000000d4")
    })
    const next = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue",
    )!
    await act(async () => next.click())
    await act(() => new Promise((r) => setTimeout(r, 1)))

    expect(h.readStrandedToken).toHaveBeenCalledWith(
      openTestSession(),
      stuck.sipaAddress,
      "0x00000000000000000000000000000000000000d4",
      "0x00000000000000000000000000000000000000e1",
      false,
    )
    expect(document.body.querySelector("input")).toBeNull()
    expect(document.body.textContent).toContain("DAI")
  })
})
