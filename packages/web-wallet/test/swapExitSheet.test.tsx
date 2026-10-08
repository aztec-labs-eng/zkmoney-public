/**
 * The swap exit sheet a stuck or unswappable swap withdrawal opens: which exits it offers on which
 * grounds, what each promises, and what it says when one lands.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Address, Hex } from "viem"
import { passThroughScreener, ScreeningProvider, type WithdrawalRecord } from "@obsidion/front-core"
import { clearWalletPrompt, useWalletPrompt } from "../src/features/deposit/walletPrompt"

const h = vi.hoisted(() => ({
  executeSwapWithdrawal: vi.fn(),
  recoverSwapWithdrawal: vi.fn(),
  showReportableError: vi.fn(),
}))

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({
    l1ChainId: 11155111,
    l1RpcUrl: "http://127.0.0.1:8545",
    l1Chain: {
      name: "Sepolia",
      blockExplorers: { default: { url: "https://sepolia.etherscan.io" } },
    },
  }),
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  isWalletRejection: (e: { code?: number }) => e?.code === 4001,
  useL1Wallet: () => ({
    account: "0x00000000000000000000000000000000000000aa",
    connecting: false,
    wrongChain: false,
    connect: vi.fn(),
    switchNetwork: vi.fn(),
  }),
}))
vi.mock("../src/features/withdraw/swapRecovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/swapRecovery")>()),
  executeSwapWithdrawal: h.executeSwapWithdrawal,
  recoverSwapWithdrawal: h.recoverSwapWithdrawal,
}))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
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

const { SwapExitModal } = await import("../src/features/withdraw/SwapExitModal")

declare global {
  // eslint-disable-next-line no-var
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

  const button = (title: RegExp) =>
    Array.from(container.querySelectorAll("button")).find((b) => title.test(b.textContent ?? ""))
  const slotOpen = () =>
    container.querySelector<HTMLElement>('[data-testid="wallet-slot"]')!.dataset.open

  const render = async (reason: "stuck" | "unswappable", rec: WithdrawalRecord = record) => {
    await act(async () => {
      root.render(
        <ScreeningProvider screener={passThroughScreener}>
          <SwapExitModal record={rec} reason={reason} onClose={vi.fn()} />
          <SlotProbe />
        </ScreeningProvider>,
      )
    })
    // Let the pass-through screening settle so the recover button enables.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.executeSwapWithdrawal.mockResolvedValue(L1_TX)
    h.recoverSwapWithdrawal.mockResolvedValue(L1_TX)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
    clearWalletPrompt()
  })

  describe("a stuck swap", () => {
    beforeEach(() => render("stuck"))

    it("offers the swap first, and recovery as the alternative", () => {
      expect(container.textContent).toContain("Swap taking too long")
      expect(button(/^Run the swap now$/)).toBeTruthy()
      expect(button(/^Recover DAI to/)).toBeTruthy()
      expect(container.textContent).toMatch(/instead of swapping it/)
    })

    it("promises what the factory route delivers: gas out, the reserved fee back, a lost race costs nothing", () => {
      const text = container.textContent!
      expect(text).toMatch(/paid in the asset you chose/)
      expect(text).toMatch(/comes back to your wallet/)
      expect(text).toMatch(/completes without doing anything/)
    })

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

  describe("an unswappable swap", () => {
    beforeEach(() => render("unswappable", { ...record, phase: "recoverable" }))

    it("offers recovery alone and says why the swap cannot run", () => {
      expect(container.textContent).toContain("Recover withdrawal")
      expect(button(/^Run the swap now$/)).toBeUndefined()
      expect(button(/^Recover DAI to/)).toBeTruthy()
      expect(container.textContent).toMatch(/can't complete right now/)
      expect(container.textContent).toMatch(/DAI is safe in the escrow/)
    })

    it("recovers to the recipient by default and links the transaction", async () => {
      await act(async () => button(/^Recover DAI to/)!.click())
      expect(h.recoverSwapWithdrawal).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "recoverable" }),
        expect.objectContaining({ destination: RECIPIENT }),
      )
      expect(container.textContent).toContain("210 DAI sent to")
      expect(container.textContent).toContain("Transaction ID")
    })

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

    it.each([
      ["a closed passkey prompt", Object.assign(new Error("closed"), { name: "NotAllowedError" })],
      ["a rejected wallet request", Object.assign(new Error("rejected"), { code: 4001 })],
    ])("returns to the form quietly on %s", async (_, err) => {
      h.recoverSwapWithdrawal.mockRejectedValueOnce(err)
      await act(async () => button(/^Recover DAI to/)!.click())
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(button(/^Recover DAI to/)).toBeTruthy()
    })
  })
})
