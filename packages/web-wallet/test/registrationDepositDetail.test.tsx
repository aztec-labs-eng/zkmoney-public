import React, { act } from "react"
import { MemoryRouter } from "react-router-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  passThroughScreener,
  ScreeningProvider,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import type { Hex } from "viem"
import type { PasskeyRequestScope } from "@obsidion/passkey-web"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "./support/passkeyTelemetryHarness"

const h = vi.hoisted(() => ({
  copied: [] as string[],
  fireEvent: vi.fn(),
  reusePasskeyAccount: vi.fn(),
  manualRegistrationSweep: vi.fn(),
  l1: { account: null as string | null, walletName: null as string | null, connect: vi.fn() },
  writeContract: vi.fn(async () => "0xtx"),
  getL1Clients: vi.fn(),
}))
h.getL1Clients.mockImplementation(async () => ({
  walletClient: { writeContract: h.writeContract },
  account: h.l1.account,
  chain: { id: 11155111 },
}))

vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => h.l1,
  getL1Clients: h.getL1Clients,
}))
vi.mock("../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1Chain: { name: "Sepolia" }, l1ChainId: 11155111 }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({}),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({
    readContract: async () => 0n,
    getLogs: async () => [],
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFundingTransfers: async () => [],
  readSweepEvents: async () => [],
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  // The modal reads the Aztec context at render (manual-sweep action).
  useAztecContext: () => ({ obsidionWallet: {} }),
}))
vi.mock("../src/ui/hooks", () => ({
  useCopy: () => ({
    copied: false,
    copy: (text: string) => h.copied.push(text),
  }),
}))
vi.mock("../src/features/onboarding/oxideOnboarding", () => ({
  reusePasskeyAccount: h.reusePasskeyAccount,
}))
vi.mock("../src/features/onboarding/registrationSweep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/registrationSweep")>()),
  manualRegistrationSweep: h.manualRegistrationSweep,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ probePhoneReach: async () => "unknown" }),
}))
vi.mock("../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analytics")>()),
  fireEvent: h.fireEvent,
}))
vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
  }: {
    title: string
    testId?: string
    onClick?: () => void
  }) => (
    <button data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  TopNavIconButton: ({ onClick }: { onClick?: () => void }) => <button onClick={onClick}>x</button>,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value?: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
}))

const { RegistrationDepositDetailModal } = await import(
  "../src/features/onboarding/RegistrationDepositDetailModal"
)
const { DepositAddressRow } = await import("../src/features/onboarding/steps/DepositAddress")
const { registrationDepositGross } = await import("../src/features/onboarding/registrationTerms")

const SIPA = "0x00000000000000000000000000000000000000c3"
const TOKEN = "0x00000000000000000000000000000000000000d4"

const record = (over: Partial<PendingRegistrationRecord> = {}): PendingRegistrationRecord =>
  ({
    account: "0x00000000000000000000000000000000000000f1",
    tag: "taga",
    nameHash: `0x${"11".repeat(32)}` as Hex,
    l2Address: `0x${"22".repeat(32)}` as Hex,
    l1ChainId: 11155111,
    sipaAddress: SIPA,
    depositToken: TOKEN as Hex,
    broadcast: true,
    phase: "awaiting_deposit",
    startTime: Date.now() - 60_000,
    ...over,
  } as PendingRegistrationRecord)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  h.copied.length = 0
  h.writeContract.mockClear()
  h.reusePasskeyAccount.mockReset()
  h.manualRegistrationSweep.mockReset().mockResolvedValue(`0x${"5e".repeat(32)}`)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (node: React.ReactElement) =>
  act(() =>
    root.render(
      <MemoryRouter>
        <ScreeningProvider screener={passThroughScreener}>{node}</ScreeningProvider>
      </MemoryRouter>,
    ),
  )
const buttons = () => Array.from(container.querySelectorAll("button"))

describe("DepositAddressRow", () => {
  it("copies the address untruncated, and keeps it whole for a reader", () => {
    render(<DepositAddressRow address={SIPA as never} />)
    const btn = buttons().find((b) => b.getAttribute("aria-label")?.startsWith("Copy deposit"))!
    // The design shortens what is drawn; a mistyped deposit is unrecoverable, so the whole
    // address stays reachable and is what the button puts on the clipboard.
    expect(btn.getAttribute("aria-label")).toContain(SIPA)
    expect(btn.getAttribute("title")).toBe(SIPA)
    act(() => btn.click())
    expect(h.copied).toEqual([SIPA])
  })
})

describe("registrationDepositGross", () => {
  const dai = (n: bigint) => n * 10n ** 18n

  it("credits the summed funding of a topped-up deposit, not the first tranche", () => {
    // Case B: 5 DAI then +6 top-up = 11 deposited. The address is swept (live 0) and the stamped
    // terms are stuck at the shortfall-time first tranche; the summed on-chain funding wins.
    expect(registrationDepositGross(0n, dai(11n), dai(5n))).toBe(dai(11n))
  })

  it("matches a single-tranche deposit (Case A)", () => {
    expect(registrationDepositGross(0n, dai(11n), dai(11n))).toBe(dai(11n))
  })

  it("prefers the live balance while the address still holds it", () => {
    expect(registrationDepositGross(dai(11n), 0n, 0n)).toBe(dai(11n))
  })

  it("falls back to the stamped terms before the funding read lands", () => {
    expect(registrationDepositGross(0n, 0n, dai(5n))).toBe(dai(5n))
  })

  it("leaves a genuinely short deposit short", () => {
    expect(registrationDepositGross(0n, dai(5n), dai(5n))).toBe(dai(5n))
  })
})

describe("RegistrationDepositDetailModal", () => {
  const base = {
    terms: null,
    amount: "+11 DAI",
    feeLabel: "1 DAI",
    // The row that opens this holds the reads; a zero cut is what this deployment answers.
    sweepFee: 0n,
    deductions: { fpcCut: 0n },
    onClose: () => {},
  }

  /** What a campaign registration stores while it is quoted the standard schedule. */
  const quotedTerms = (fee: string, earnedExpected: boolean) => ({
    account: record().account,
    tag: "taga",
    deadline: 0,
    fee,
    minDeposit: String(5n * 10n ** 18n),
    feeWaived: false,
    ...(earnedExpected ? { earnedExpected: true } : {}),
  })

  it("connects a wallet, then pays the exact amount from it, while the address still needs funds", async () => {
    const pay = {
      token: TOKEN as never,
      chainId: 11155111,
      total: 11n * 10n ** 18n,
      tokenSymbol: "DAI",
    }
    render(<RegistrationDepositDetailModal record={record()} {...base} pay={pay} />)
    act(() =>
      buttons()
        .find((b) => b.textContent?.includes("Connect your wallet"))!
        .click(),
    )
    expect(h.l1.connect).toHaveBeenCalledTimes(1)
    expect(h.writeContract).not.toHaveBeenCalled()

    h.l1.account = "0x00000000000000000000000000000000000000aa"
    h.l1.walletName = "Rainbow"
    render(<RegistrationDepositDetailModal record={record()} {...base} pay={pay} />)
    await act(async () =>
      buttons()
        .find((b) => b.textContent?.includes("Pay from Rainbow"))!
        .click(),
    )
    expect(h.getL1Clients).toHaveBeenCalledWith(11155111, h.l1.account)
    expect(h.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: "transfer",
        args: [SIPA, pay.total],
      }),
    )
    expect(buttons().some((b) => b.textContent?.includes("Payment sent"))).toBe(true)
    // Both the inline row and the detail row copy the full address.
    const copies = buttons().filter((b) =>
      b.getAttribute("aria-label")?.startsWith("Copy deposit address"),
    )
    expect(copies.length).toBe(2)
    act(() => copies.forEach((b) => b.click()))
    expect(h.copied).toEqual([SIPA, SIPA])
    h.l1.account = null
    h.l1.walletName = null
  })

  it("removes payment controls when the promised deposit admits the wallet", async () => {
    const original = record({
      fee: "10000000000000000000",
      sipaAddress: "0x00000000000000000000000000000000000000c5",
    })
    const pay = {
      token: TOKEN as Hex,
      chainId: 11155111,
      total: 15n * 10n ** 18n,
      tokenSymbol: "DAI",
    }
    render(
      <RegistrationDepositDetailModal
        record={original}
        {...base}
        terms={quotedTerms(original.fee!, true)}
        amount="Deposit"
        deposited="5 DAI"
        pay={pay}
      />,
    )
    expect(buttons().some((b) => b.textContent?.includes("Connect your wallet"))).toBe(true)
    const { recordDepositAdmission } = await import("../src/features/identity/admission")
    await act(async () => {
      recordDepositAdmission(original, 5n * 10n ** 18n)
    })
    expect(buttons().some((b) => b.textContent?.includes("Connect your wallet"))).toBe(false)
    expect(container.textContent).toContain("Recover this deposit")
    expect(container.textContent).toContain("5 DAI")
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Copy deposit address"]')!.click(),
    )
    expect(h.copied).toContain(original.sipaAddress)
    expect(container.querySelector("a[href='/claim/taga?recovery=1']")).not.toBeNull()
    expect(h.writeContract).not.toHaveBeenCalled()
    expect(container.querySelector("[data-testid='manual-sweep']")).toBeNull()
  })

  // The standard fee and the earned ask are one figure, so a registration nobody promised the
  // earned price keeps its payment controls and is never offered a recovery it does not need.
  it("keeps a standard registration on its own quote when the deposit admits the wallet", async () => {
    const standard = record({
      fee: String(5n * 10n ** 18n),
      sipaAddress: "0x00000000000000000000000000000000000000c6",
    })
    render(
      <RegistrationDepositDetailModal
        record={standard}
        {...base}
        terms={quotedTerms(standard.fee!, false)}
        amount="Deposit"
        deposited="15 DAI"
      />,
    )
    const { recordDepositAdmission } = await import("../src/features/identity/admission")
    await act(async () => {
      recordDepositAdmission(standard, 15n * 10n ** 18n)
    })
    expect(container.textContent).not.toContain("Recover this deposit")
  })

  it("itemizes gross, registration fee and gas sponsorship against the credited headline", () => {
    render(
      <RegistrationDepositDetailModal
        record={record({ fundedAt: Date.now() })}
        {...base}
        amount="+9.75 DAI"
        deposited="11 DAI"
        cutLabel="0.25 DAI"
      />,
    )
    expect(rowById("registration-detail-deposited")).toBe("11 DAI")
    expect(rowById("registration-detail-fee")).toBe("1 DAI")
    expect(rowById("registration-detail-cut")).toBe("0.25 DAI")
    expect(container.textContent).toContain("+9.75 DAI")
  })

  it("leaves the gas-sponsorship row out while the portal's cut is unread", () => {
    render(<RegistrationDepositDetailModal record={record({ fundedAt: Date.now() })} {...base} />)
    expect(rowById("registration-detail-cut")).toBeUndefined()
  })

  it("holds the deposited row open while no read has named a gross", () => {
    // The headline stands in for a figure the feed has not got; the row waits for the real one,
    // the way the funder row does.
    render(<RegistrationDepositDetailModal record={record()} {...base} amount="Deposit" />)
    expect(rowById("registration-detail-deposited")).toBeUndefined()
    expect(rowValue("Deposited")).toBe(rowValue("Funder"))
    expect(rowValue("Deposited")).not.toBe("Deposit")
  })

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const rowById = (id: string) => byTestId(id)?.textContent ?? undefined
  /** A detail row's value, by its label: the row renders label and value as sibling spans. */
  const rowValue = (label: string) =>
    Array.from(container.querySelectorAll("span")).find((s) => s.textContent === label)
      ?.nextElementSibling?.textContent ?? undefined
  const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))
  type Gate = (opts?: unknown) => Promise<{ signal: AbortSignal; route?: string; reach: string }>
  const gatedRecovery = (then: () => unknown) =>
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, gate: Gate) => {
        await gate()
        return then()
      },
    )

  it("closing the modal past the prompt ends the sign-in, so nothing sweeps", async () => {
    let attempt: AbortSignal | undefined
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, gate: Gate) => {
        attempt = (await gate()).signal
        await new Promise(() => {})
      },
    )
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await act(async () => byTestId("manual-sweep")!.click())
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(attempt?.aborted).toBe(false)
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(attempt?.aborted).toBe(true)
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
  })

  it("closing the modal while the held key is being adopted ends that too", async () => {
    let scope: AbortSignal | undefined
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, _gate: Gate, signal: AbortSignal) => {
        scope = signal
        await new Promise(() => {})
      },
    )
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await act(async () => byTestId("manual-sweep")!.click())
    await flush()
    expect(scope?.aborted).toBe(false)
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(scope?.aborted).toBe(true)
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
  })

  it("the manual sweep holds at the phone steps until Continue", async () => {
    gatedRecovery(() => ({ secretKey: "0x1" }))
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await act(async () => byTestId("manual-sweep")!.click())
    await flush()
    expect(byTestId("sign-in-sheet")).not.toBeNull()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(h.manualRegistrationSweep).toHaveBeenCalledOnce()
    expect(byTestId("sign-in-sheet")).toBeNull()
  })

  it("a policy refusal on the manual sweep renders in place with a retry", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    gatedRecovery(() => {
      throw new PhoneRequiredError()
    })
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await act(async () => byTestId("manual-sweep")!.click())
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(byTestId("manual-sweep-refused")?.dataset.reason).toBe("PhoneRequiredError")
    expect(byTestId("manual-sweep-error")).toBeNull()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    await act(async () => byTestId("manual-sweep-retry")!.click())
    await flush()
    expect(byTestId("sign-in-sheet")).not.toBeNull()
  })

  it("a refusal another attempt cannot fix hides the sweep link and offers no retry", async () => {
    const { RotatedCredentialError } = await import("@obsidion/passkey-web")
    gatedRecovery(() => {
      throw new RotatedCredentialError()
    })
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await act(async () => byTestId("manual-sweep")!.click())
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(byTestId("manual-sweep-refused")?.dataset.reason).toBe("RotatedCredentialError")
    expect(byTestId("manual-sweep-retry")).toBeNull()
    expect(byTestId("manual-sweep")).toBeNull()
  })

  describe("passkey telemetry", () => {
    const events = () => passkeyEvents(h.fireEvent)
    let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
    /** Renders the modal this test's page load imported. */
    let show: (over?: Partial<PendingRegistrationRecord>) => Promise<void>

    /** The sweep's sign-in asks through the tracker once past the gate and waits for the test. */
    const heldRecovery = () => {
      const held: { request?: HeldRequest } = {}
      h.reusePasskeyAccount.mockImplementation(
        async (
          _w: unknown,
          _a: unknown,
          _h: unknown,
          gate: Gate,
          signal?: AbortSignal,
          own?: PasskeyRequestScope,
        ) => {
          await gate()
          held.request = harness.request("assert", signal, own)
          await held.request.settled
          return { secretKey: "0x1" }
        },
      )
      return held
    }
    const toRequest = async () => {
      const held = heldRecovery()
      await show()
      await act(async () => byTestId("manual-sweep")!.click())
      await flush()
      await act(async () => byTestId("sign-in-continue")!.click())
      await flush()
      expect(held.request).toBeDefined()
    }

    beforeEach(async () => {
      // An attempt an earlier test left open ends here, before this test counts anything.
      pageHide()
      h.fireEvent.mockClear()
      // A fresh page load: its own tracker, so attempt numbers and once-per-page events start over.
      vi.resetModules()
      const { ScreeningProvider: Screening, passThroughScreener: screener } = await import(
        "@obsidion/front-core"
      )
      const { RegistrationDepositDetailModal: Detail } = await import(
        "../src/features/onboarding/RegistrationDepositDetailModal"
      )
      harness = await passkeyTelemetryHarness()
      show = (over = {}) =>
        act(async () => {
          root.render(
            <Screening screener={screener}>
              <Detail record={record(over)} {...base} />
            </Screening>,
          )
        })
    })

    it("closing the modal during the sweep's request is the user's cancel, sent once", async () => {
      await toRequest()
      act(() => {
        buttons()
          .find((b) => b.textContent === "x")!
          .click()
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
      expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    })

    it("the sweep leaving because the registration moved on sends nothing", async () => {
      await toRequest()
      await show({ sweptAt: Date.now() })
      await flush()
      expect(byTestId("manual-sweep")).toBeNull()
      act(() => pageHide())
      expect(events()).toEqual([])
    })

    it("a cancel at the sweep's phone steps, then leaving at once, sends one in-app cancel", async () => {
      heldRecovery()
      await show()
      await act(async () => byTestId("manual-sweep")!.click())
      await flush()
      act(() => {
        byTestId("sign-in-cancel")!.click()
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
          prompts: "0",
        }),
      ])
      expect(events()[0]).not.toHaveProperty("attempt")
    })
  })

  it("keeps the copyable address row but no QR once the deposit is in", () => {
    render(<RegistrationDepositDetailModal record={record({ fundedAt: Date.now() })} {...base} />)
    expect(container.querySelector(".ww-deposit-address-block")).toBeNull()
    const copies = buttons().filter((b) => b.getAttribute("aria-label") === "Copy deposit address")
    expect(copies.length).toBe(1)
    act(() => copies[0].click())
    expect(h.copied).toEqual([SIPA])
  })
})
