/**
 * The swap exit sheet a stuck or unswappable swap withdrawal opens: which exits it offers on which
 * grounds, what each promises, and what it says when one lands.
 */
import { createPace } from "@obsidion/core/cadence"
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Address, Hex } from "viem"
import {
  passThroughScreener,
  ScreeningProvider,
  type MoveQuote,
  type MoveRecord,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { l1ExitChannel, type MoveSendWatch } from "../../../src/features/withdraw/swapRecovery"
import type { Session } from "../../../src/session/session"
import { useWalletPrompt } from "../../../src/session/walletPrompt"
import { moveRecord } from "../../support/moves"
import { testScreenings } from "../../support/page"
const pace = createPace()

const h = vi.hoisted(() => ({
  executeSwapWithdrawal: vi.fn(),
  recoverSwapWithdrawal: vi.fn(),
  recoverMove: vi.fn(),
  runMove: vi.fn(),
  showReportableError: vi.fn(),
}))

vi.mock("../../../src/session/useL1Wallet", () => ({
  isWalletRejection: (e: { code?: number }) => e?.code === 4001,
  useL1Wallet: () => ({
    account: "0x00000000000000000000000000000000000000aa",
    connecting: false,
    wrongChain: false,
    connect: vi.fn(),
    switchNetwork: vi.fn(),
  }),
}))
vi.mock("../../../src/features/withdraw/swapRecovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/withdraw/swapRecovery")>()),
  executeSwapWithdrawal: h.executeSwapWithdrawal,
  recoverSwapWithdrawal: h.recoverSwapWithdrawal,
}))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
// The DS drags in liquid-glass optics jsdom can't render; this test is about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      <span>{value}</span>
    </div>
  ),
  DoubleCheckIcon: () => null,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button onClick={onClick} disabled={isDisabled}>
      {title}
    </button>
  ),
  RowChevron: () => null,
  Spinner: () => null,
  TextField: ({
    label,
    value,
    onChange,
  }: {
    label: string
    value: string
    onChange: (v: string) => void
  }) => (
    <label>
      {label}
      <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  ),
  TopNavIconButton: () => null,
}))

const { SwapExitModal } = await import("../../../src/features/withdraw/SwapExitModal")
const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const L1_TX = `0x${"ab".repeat(32)}` as Hex
const RECIPIENT = `0x${"dd".repeat(20)}` as Address

const record = {
  localId: "wdraw_1",
  recipient: RECIPIENT,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  phase: "swapping",
  startTime: Date.now() - 6 * 60_000,
  phaseEnteredAt: Date.now() - 6 * 60_000,
  l2TxHash: `0x${"0a".repeat(32)}`,
  swapOutput: "USDC",
  swapEscrow: `0x${"e5".repeat(20)}`,
  swapEscrowFactory: `0x${"fa".repeat(20)}`,
  swapNonce: `0x${"77".repeat(32)}`,
  swapRecoveryCommitment: `0x${"5a".repeat(32)}`,
  swapRelayerTip: "5000000000000000000",
} as WithdrawalRecord

/** The page-wide wallet slot, read as the sheets read it. */
function SlotProbe() {
  return <span data-testid="wallet-slot" data-open={String(useWalletPrompt().open)} />
}

describe("SwapExitModal", () => {
  let container: HTMLDivElement
  let root: Root
  let session: Session

  const button = (title: RegExp) =>
    Array.from(container.querySelectorAll("button")).find((b) => title.test(b.textContent ?? ""))
  const slotOpen = () =>
    container.querySelector<HTMLElement>('[data-testid="wallet-slot"]')!.dataset.open

  const render = async (
    reason: "stuck" | "unswappable",
    rec: WithdrawalRecord | undefined = record,
    move?: { record: MoveRecord; run: boolean },
  ) => {
    const props = move ? { record: rec, move } : { record: rec ?? record }
    await act(async () => {
      root.render(
        <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
          <SwapExitModal {...props} reason={reason} pace={pace} onClose={vi.fn()} />
          <SlotProbe />
        </ScreeningProvider>,
      )
    })
    // Let the pass-through screening settle so the recover button enables.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  /** Types the recovery's destination, and lets its screening settle. */
  const typeDestination = async (typed: string) => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Recover DAI to"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, typed)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.executeSwapWithdrawal.mockResolvedValue(L1_TX)
    h.recoverSwapWithdrawal.mockResolvedValue(L1_TX)
    h.recoverMove.mockResolvedValue(L1_TX)
    h.runMove.mockResolvedValue(L1_TX)
    session = openTestSession({ moveCommands: { recover: h.recoverMove, run: h.runMove } })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    closeSession()
    vi.clearAllMocks()
  })

  describe("a stuck swap", () => {
    beforeEach(() => render("stuck"))

    it("runs the swap from the button and says the recipient was paid", async () => {
      await act(async () => button(/^Run the swap now$/)!.click())
      expect(h.executeSwapWithdrawal).toHaveBeenCalledWith(record, expect.anything())
      expect(container.textContent).toContain("Swap complete")
      expect(container.textContent).toMatch(/Swapped to USDC and sent to/)
    })

    it("withdraws the swap once the tracker parks the escrow as unfillable", async () => {
      expect(button(/^Run the swap now$/)).toBeTruthy()
      await render("stuck", { ...record, phase: "recoverable" })
      expect(button(/^Run the swap now$/)).toBeUndefined()
      expect(container.textContent).toContain("Recover withdrawal")
      expect(button(/^Recover DAI to/)).toBeTruthy()
    })

    it("offers a way back after 30 seconds at the wallet prompt, and swallows a late rejection", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const held = {} as { reject: (e: unknown) => void }
        h.executeSwapWithdrawal.mockImplementationOnce(
          (_record: unknown, opts: { onStage: (stage: string) => void }) => {
            opts.onStage("signing")
            return new Promise<never>((_, reject) => Object.assign(held, { reject }))
          },
        )
        await act(async () => button(/^Run the swap now$/)!.click())
        expect(container.textContent).toContain("Approve the swap in your wallet")
        await act(async () => vi.advanceTimersByTime(30_000))
        const note = container.querySelector<HTMLElement>('[data-testid="wallet-prompt-stall"]')!
        expect(note.textContent).toContain("Still waiting for your wallet.")
        await act(async () => note.querySelector("button")!.click())
        expect(button(/^Run the swap now$/)!.disabled).toBe(false)
        await act(async () => button(/^Run the swap now$/)!.click())
        expect(h.executeSwapWithdrawal).toHaveBeenCalledTimes(1)
        expect(container.querySelector('[data-testid="swap-exit-refused"]')?.textContent).toBe(
          "Your wallet still has the previous request open. Approve or reject it there first.",
        )
        await act(async () => held.reject(new Error("wallet closed")))
        expect(h.showReportableError).not.toHaveBeenCalled()
        expect(button(/^Run the swap now$/)!.disabled).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it("frees the slot once the swap is confirming, before the receipt lands", async () => {
      let stage!: (stage: string) => void
      h.executeSwapWithdrawal.mockImplementationOnce(
        (_record: unknown, opts: { onStage: (stage: string) => void }) => {
          stage = opts.onStage
          opts.onStage("signing")
          return new Promise<never>(() => {})
        },
      )
      await act(async () => button(/^Run the swap now$/)!.click())
      expect(slotOpen()).toBe("true")
      await act(async () => stage("confirming"))
      expect(slotOpen()).toBe("false")
      expect(button(/^Run the swap now$/)).toBeUndefined()
    })

    it("starts the recovery destination at the withdrawal's recipient and lets it be changed", async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Recover DAI to"]')!
      expect(input.value).toBe(RECIPIENT)
      const typed = `0x${"55".repeat(20)}`
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        setter.call(input, typed)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      await act(async () => button(/^Recover DAI to/)!.click())
      expect(h.recoverSwapWithdrawal).toHaveBeenCalledWith(
        record,
        expect.objectContaining({ destination: typed }),
      )
      expect(container.textContent).toContain("Withdrawal recovered")
    })
  })

  describe("a Savings move whose escrow nobody ran", () => {
    const move = moveRecord({
      direction: "out",
      amount: 10n,
      quote: { expectedOut: 105n * 10n ** 18n } as MoveQuote,
    })
    const escrow = move.rail === "skyEscrow" ? move.escrow.address : undefined
    const burn = { ...record, phase: "done", recipient: escrow } as WithdrawalRecord
    beforeEach(() => render("stuck", burn, { record: move, run: true }))

    it("offers the run first, and recovery to an address the user types", () => {
      expect(container.textContent).toContain("Move taking too long")
      expect(container.textContent).toMatch(/the funds go on to Main Account/)
      expect(container.textContent).toContain("$105.00")
      expect(button(/^Run the move now$/)).toBeTruthy()
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Recover DAI to"]')!.value,
      ).toBe("")
    })

    it("runs the escrow from the button and says where the funds went", async () => {
      await act(async () => button(/^Run the move now$/)!.click())
      expect(h.runMove).toHaveBeenCalledWith(move.id, expect.anything())
      expect(h.executeSwapWithdrawal).not.toHaveBeenCalled()
      expect(container.textContent).toContain("Move sent on")
      expect(container.textContent).toMatch(/Sent on to Main Account/)
    })

    it("offers only recovery once the relayer dropped a move this device did not burn", async () => {
      await render("stuck", undefined, { record: move, run: false })
      expect(button(/^Run the move now$/)).toBeUndefined()
      expect(button(/^Recover DAI/)).toBeTruthy()
    })

    it("recovers the escrow's DAI to the typed address", async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Recover DAI to"]')!
      const typed = `0x${"55".repeat(20)}`
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        setter.call(input, typed)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      await act(async () => button(/^Recover DAI to/)!.click())
      expect(h.recoverMove).toHaveBeenCalledWith(move.id, typed, expect.anything())
      expect(h.executeSwapWithdrawal).not.toHaveBeenCalled()
      expect(container.textContent).toContain("Move recovered")
    })

    it("shows where the browser's page opened while the move's run waits on it", async () => {
      const page = "http://127.0.0.1:4173/l1-submit#run"
      h.runMove.mockImplementationOnce((_id: string, watch?: MoveSendWatch) => {
        watch?.onStage?.("awaiting-browser")
        watch?.onHelperOpened?.(page)
        return new Promise<never>(() => {})
      })
      await act(async () => button(/^Run the move now$/)!.click())
      expect(container.textContent).toContain(page)
    })

    it("shows the burned amount on the desktop helper page the move's run opens", async () => {
      const shown: string[][] = []
      vi.stubGlobal("__ZKMONEY_DESKTOP_BRIDGE__", { l1SubmitPath: "/desktop/l1-submit" })
      // The launcher takes the request and never answers: the run stays open.
      vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
        const { display } = JSON.parse(String(init?.body)) as { display: { lines: string[][] } }
        shown.push(display.lines.map(([, value]) => value!))
        return new Promise<Response>(() => {})
      })
      h.runMove.mockImplementationOnce(async (_id: string, watch?: MoveSendWatch) => {
        const paid = { label: "Escrow", address: escrow! }
        const channel = await l1ExitChannel(session, "Run", paid, watch)
        return channel.sendTransaction(escrow!, "0x")
      })
      await act(async () => button(/^Run the move now$/)!.click())
      vi.unstubAllGlobals()
      expect(shown[0]).toContain([burn.amount, burn.tokenSymbol].join(" "))
    })

    it("frees the slot once the move's recovery is confirming, before the receipt lands", async () => {
      let stage: MoveSendWatch["onStage"]
      h.recoverMove.mockImplementationOnce((_id: string, _to: Address, watch?: MoveSendWatch) => {
        stage = watch?.onStage
        stage?.("signing")
        return new Promise<never>(() => {})
      })
      await render("stuck", undefined, { record: move, run: false })
      await typeDestination(`0x${"55".repeat(20)}`)
      await act(async () => button(/^Recover DAI to/)!.click())
      expect(slotOpen()).toBe("true")
      await act(async () => stage?.("confirming"))
      expect(slotOpen()).toBe("false")
    })
  })

  describe("an unswappable swap", () => {
    beforeEach(() => render("unswappable", { ...record, phase: "recoverable" }))

    it("surfaces a failed recovery and returns to the form", async () => {
      h.recoverSwapWithdrawal.mockRejectedValueOnce(new Error("reverted"))
      await act(async () => button(/^Recover DAI to/)!.click())
      expect(h.showReportableError).toHaveBeenCalledWith(
        expect.any(Error),
        "withdrawal:recovery",
        expect.objectContaining({ title: "Recovery failed" }),
      )
      expect(button(/^Recover DAI to/)).toBeTruthy()
    })

    it("returns to the form quietly on a closed passkey prompt", async () => {
      h.recoverSwapWithdrawal.mockRejectedValueOnce(
        Object.assign(new Error("closed"), { name: "NotAllowedError" }),
      )
      await act(async () => button(/^Recover DAI to/)!.click())
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(button(/^Recover DAI to/)).toBeTruthy()
    })
  })
})
