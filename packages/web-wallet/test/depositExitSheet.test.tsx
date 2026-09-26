/**
 * The deposit exit sheet a stuck deposit opens: it says how long the deposit has been waiting,
 * offers the sweep by name, and links the L1 transaction it ends on.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import {
  formatTimeLabel,
  passThroughScreener,
  PendingRegistrationStore,
  ScreeningProvider,
  type AddressScreener,
  type PendingRegistrationRecord,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import type { Address, Hex } from "viem"
import type { PasskeyRequestScope } from "@obsidion/passkey-web"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "./support/passkeyTelemetryHarness"

const EXPLORER = "https://sepolia.etherscan.io"
const SWEEP_HASH = `0x${"5e".repeat(32)}` as Hex

const h = vi.hoisted(() => ({
  fireEvent: vi.fn(),
  selfSweep: vi.fn(),
  manualRegistrationSweep: vi.fn(),
  reusePasskeyAccount: vi.fn(),
  showReportableError: vi.fn(),
  // Swapped per describe: undefined for the plain-deposit tests, truthy for the registration ones.
  wallet: { current: undefined as unknown },
}))

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({
    l1ChainId: 11155111,
    l1RpcUrl: "http://127.0.0.1:8545",
    l1Chain: { name: "Sepolia", blockExplorers: { default: { url: EXPLORER } } },
  }),
}))
vi.mock("../src/features/deposit/l1Wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/l1Wallet")>()),
  useL1Wallet: () => ({
    account: "0x00000000000000000000000000000000000000aa",
    connecting: false,
    wrongChain: false,
    connect: vi.fn(),
    switchNetwork: vi.fn(),
  }),
}))
vi.mock("../src/features/deposit/sipaSweep", () => ({ selfSweep: h.selfSweep }))
vi.mock("../src/features/deposit/sipaRecovery", () => ({ recoverDeposit: vi.fn() }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: h.wallet.current }),
}))
// The passkey helper drags the onboarding flow in; the registration tests only need its keys.
vi.mock("../src/features/onboarding/oxideOnboarding", () => ({
  reusePasskeyAccount: h.reusePasskeyAccount,
}))
// Keep registrationRecordForSipa/canManualRegistrationSweep real — the seeded pending store is
// what drives the routing under test; only the L1-touching sweep itself is stubbed.
vi.mock("../src/features/onboarding/registrationSweep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/registrationSweep")>()),
  manualRegistrationSweep: h.manualRegistrationSweep,
}))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  failureCode: () => "x",
  lapTimer: () => () => 0,
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ probePhoneReach: async () => "unknown" }),
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      <span>{value}</span>
    </div>
  ),
  DoubleCheckIcon: () => null,
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
  Spinner: () => null,
  TextField: () => null,
  TopNavIconButton: () => null,
}))

const { DepositExitModal, waitedLabel } = await import("../src/features/deposit/DepositExitModal")
const { getPendingStore } = await import("../src/features/onboarding/webRegistration")

declare global {
  // eslint-disable-next-line no-var
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
} as SIPADepositRecord

describe("waitedLabel", () => {
  it("counts whole minutes, and hours once there are any", () => {
    expect(waitedLabel(0)).toBe("0m")
    expect(waitedLabel(90_000)).toBe("1m")
    expect(waitedLabel(59 * 60_000)).toBe("59m")
    expect(waitedLabel(60 * 60_000)).toBe("1h 00m")
    expect(waitedLabel((3 * 60 + 5) * 60_000)).toBe("3h 05m")
  })
})

describe("DepositExitModal — stuck deposit", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  // The second act flushes the screening hook's zero-delay debounce timer.
  const render = async (screener: AddressScreener = passThroughScreener) => {
    await act(async () => {
      root.render(
        <ScreeningProvider screener={screener}>
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

  it("shows when the deposit started and how long it has waited", () => {
    expect(container.textContent).toContain("Started")
    expect(container.textContent).toContain(formatTimeLabel(STARTED_AT))
    expect(container.textContent).toContain("Waiting")
    expect(container.textContent).toContain("3h 05m")
  })

  it("sweeps from a button named for the row action that opened it", async () => {
    expect(button("Sweep now")).toBeTruthy()
    await act(async () => button("Sweep now")!.click())
    expect(h.selfSweep).toHaveBeenCalledOnce()
  })

  it("links the sweep transaction once it lands", async () => {
    await act(async () => button("Sweep now")!.click())
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`${EXPLORER}/tx/${SWEEP_HASH}`)
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

describe("DepositExitModal — registration-backed deposit", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  const registration = (
    over: Partial<PendingRegistrationRecord> = {},
  ): Omit<PendingRegistrationRecord, "account"> => ({
    tag: "alice",
    nameHash: `0x${"77".repeat(32)}` as Hex,
    l2Address: stuck.recipientL2Address as Hex,
    l1ChainId: 11155111,
    sipaAddress: stuck.sipaAddress,
    depositToken: "0x00000000000000000000000000000000000000d4" as Hex,
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    ...over,
  })

  const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address

  const render = async (Exit = DepositExitModal, Screening = ScreeningProvider) => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <Screening screener={passThroughScreener}>
          <Exit record={stuck} reason="stuck" canSweep onClose={vi.fn()} />
        </Screening>,
      )
    })
    await act(() => new Promise((r) => setTimeout(r, 1)))
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    h.wallet.current = {}
    h.reusePasskeyAccount.mockResolvedValue({ secretKey: "0x1" })
    h.manualRegistrationSweep.mockResolvedValue(SWEEP_HASH)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    h.wallet.current = undefined
    vi.clearAllMocks()
  })

  it("routes the sweep through the registration path, never the plain one", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, registration())
    await render()
    expect(container.textContent).toContain("registers your name")
    await act(async () => button("Sweep now")!.click())
    expect(h.manualRegistrationSweep).toHaveBeenCalledOnce()
    expect(h.manualRegistrationSweep.mock.calls[0][0].sipaAddress).toBe(stuck.sipaAddress)
    expect(h.manualRegistrationSweep.mock.calls[0][1].keys).toEqual({ secretKey: "0x1" })
    expect(h.selfSweep).not.toHaveBeenCalled()
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`${EXPLORER}/tx/${SWEEP_HASH}`)
  })

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))
  type GateResult = { signal: AbortSignal; reach: string }
  type Gate = () => Promise<GateResult>
  type GateWithAgain = (options?: { again?: AbortSignal }) => Promise<GateResult>
  /** A recovery that waits at the gate the way the real one does. */
  const gatedRecovery = (then: () => unknown) =>
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, gate: Gate) => {
        await gate()
        return then()
      },
    )

  it("on a laptop the sweep holds at the phone steps until Continue", async () => {
    gatedRecovery(() => ({ secretKey: "0x1" }))
    await getPendingStore().upsert(ACCOUNT, {}, registration())
    await render()
    await act(async () => button("Sweep now")!.click())
    await flush()
    expect(byTestId("sign-in-sheet")).not.toBeNull()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(h.manualRegistrationSweep).toHaveBeenCalledOnce()
    expect(byTestId("sign-in-sheet")).toBeNull()
  })

  it("Cancel at the phone steps returns to the form with nothing reported", async () => {
    gatedRecovery(() => ({ secretKey: "0x1" }))
    await getPendingStore().upsert(ACCOUNT, {}, registration())
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
    await getPendingStore().upsert(ACCOUNT, {}, registration())
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
    await getPendingStore().upsert(ACCOUNT, {}, registration())
    await render()
    await act(async () => button("Sweep now")!.click())
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(byTestId("deposit-refused")?.dataset.reason).toBe("RotatedCredentialError")
    expect(byTestId("deposit-retry")).toBeNull()
    expect(button("Sweep now")).toBeUndefined()
  })

  describe("passkey telemetry", () => {
    const events = () => passkeyEvents(h.fireEvent)
    let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
    /** Seeds the registration and opens this test's sheet at its sign-in step. */
    let toSignInStep: () => Promise<void>

    beforeEach(async () => {
      // An attempt an earlier test left open ends here, before this test counts anything.
      pageHide()
      h.fireEvent.mockClear()
      // A fresh page load: its own tracker, so attempt numbers and once-per-page events start over.
      vi.resetModules()
      const { ScreeningProvider: Screening } = await import("@obsidion/front-core")
      const { DepositExitModal: Exit } = await import("../src/features/deposit/DepositExitModal")
      const { getPendingStore: pendingStore } = await import(
        "../src/features/onboarding/webRegistration"
      )
      harness = await passkeyTelemetryHarness()
      toSignInStep = async () => {
        await pendingStore().upsert(ACCOUNT, {}, registration())
        await render(Exit, Screening)
        await act(async () => button("Sweep now")!.click())
        await flush()
        expect(byTestId("sign-in-sheet")).not.toBeNull()
      }
    })

    it("a cancel at the second prompt's step, then leaving at once, sends one in-app cancel", async () => {
      // The first prompt answered; the key is settled by a second, which the gate holds for a tap.
      h.reusePasskeyAccount.mockImplementation(
        async (
          _w: unknown,
          _a: unknown,
          _h: unknown,
          gate: GateWithAgain,
          _signal?: AbortSignal,
          own?: PasskeyRequestScope,
        ) => {
          const { signal: attempt } = await gate()
          harness.request("assert", attempt, own).answer()
          await gate({ again: attempt })
          return { secretKey: "0x1" }
        },
      )
      await toSignInStep()
      await act(async () => byTestId("sign-in-continue")!.click())
      await flush()
      expect(byTestId("approve-again")).not.toBeNull()
      act(() => {
        byTestId("approve-again-cancel")!.click()
        root.unmount()
        pageHide()
      })
      root = createRoot(container)
      await flush()
      expect(events()).toEqual([
        expect.objectContaining({
          ceremony: "unlock",
          flow: "deposit",
          outcome: "cancelled",
          reason: "in_app_cancel",
          prompts: "1",
          attempt: "1",
        }),
      ])
    })

    it("leaving during the sweep's request sends nothing, then or when the page goes", async () => {
      const held: { request?: HeldRequest } = {}
      h.reusePasskeyAccount.mockImplementation(
        async (
          _w: unknown,
          _a: unknown,
          _h: unknown,
          gate: Gate,
          _signal?: AbortSignal,
          own?: PasskeyRequestScope,
        ) => {
          const { signal } = await gate()
          held.request = harness.request("assert", signal, own)
          await held.request.settled
          return { secretKey: "0x1" }
        },
      )
      await toSignInStep()
      await act(async () => byTestId("sign-in-continue")!.click())
      await flush()
      expect(held.request).toBeDefined()
      act(() => {
        root.unmount()
        pageHide()
      })
      root = createRoot(container)
      held.request!.reject(new DOMException("closed", "NotAllowedError"))
      await flush()
      expect(events()).toEqual([])
    })
  })

  it("stops before the passkey when the registration settled while the sheet was open", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, registration())
    await render()
    // The detection tick stamps the sweep after the sheet rendered its offer.
    await getPendingStore().upsert(ACCOUNT, { sweepTxHash: SWEEP_HASH })
    await act(async () => button("Sweep now")!.click())
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    expect(h.selfSweep).not.toHaveBeenCalled()
    expect(h.showReportableError).toHaveBeenCalledOnce()
  })
})
