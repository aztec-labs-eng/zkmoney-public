/**
 * Guards the move sheet decides: no move past the balance, the fee or the limit, MAX leaves no
 * dust, and no move in before its quote and terms.
 */
import { act, type ReactNode } from "react"
import type { Address } from "viem"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { liveBalances } from "../../support/balances"
import { memoryStore, WalletError, type MoveQuote } from "@obsidion/front-core"
import type { SavingsLine, SavingsPosition } from "../../../src/features/savings/savingsLine"
import type { Session } from "../../../src/session/session"
import { usdAtomicFloor } from "../../../src/ui/format"
import { openTestSession } from "../../support/session"

const ONE = 10n ** 18n
const state = vi.hoisted(() => ({
  quote: vi.fn(),
  move: vi.fn(),
  balance: 50n * 10n ** 18n,
  timing: undefined as { releaseSeconds: (at: number) => number } | undefined,
  savingsMoveEta: vi.fn(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  savingsMoveEta: state.savingsMoveEta,
  normalizeAmountInput: (v: string) => v,
  tokenAmount: (v: string) => v,
  AMOUNT_MAX_DECIMALS: 2,
  decimalPlaces: (v: string) => (v.split(".")[1] ?? "").length,
  formatDateLabel: () => "Today",
  formatTimeLabel: () => "14:32",
  isDecimalAmount: (v: string) => /^\d+(\.\d+)?$/.test(v),
  isSafeAmountNumber: () => true,
}))
vi.mock("@obsidion/passkey-web", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/passkey-web")>()),
  isPasskeyCancelled: () => false,
}))
// A small per-burn maximum and Main's dollar limit, so both are reachable in a test.
const limits = vi.hoisted(() => ({ cap: 10n ** 30n, dollars: 10n ** 30n }))
vi.mock("../../../src/features/token/useTxAmountCap", () => ({ useTxAmountCap: () => limits.cap }))
vi.mock("../../../src/features/limits/withdrawalLimit", () => ({
  withdrawalLimitProblem: (debit: bigint) => (debit > limits.dollars ? "public" : undefined),
  sharesBurnLimitProblem: (shares: bigint, cap?: bigint) =>
    cap !== undefined && shares > cap ? "protocol" : undefined,
  sharesBurnMax: (shares: bigint, cap?: bigint) =>
    cap !== undefined && shares > cap ? cap : shares,
  withdrawalMaxAtomic: (balance: bigint) => (balance > limits.dollars ? limits.dollars : balance),
}))
vi.mock("../../../src/features/limits/publicLimit", () => ({
  usdFigureGrouped: (display: string) => `$${Number(display).toFixed(2)}`,
  LimitNotice: ({
    problem,
    maximum,
    onUseMaximum,
  }: {
    problem: string
    maximum?: string
    onUseMaximum?: () => void
  }) => (
    <div data-testid="limit-notice">
      {problem === "protocol" ? "Over the network's maximum per withdrawal" : "Over the limit"}
      {onUseMaximum && <button onClick={onUseMaximum}>{`Use maximum (${maximum})`}</button>}
    </div>
  ),
}))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Spinner: () => <span data-testid="spinner" />,
  GradientText: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))
vi.mock("../../../src/ui/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
}))
vi.mock("../../../src/ui/hooks", () => ({
  useProvingOutcome: () => ({
    start: vi.fn(),
    updateStage: vi.fn(),
    finish: vi.fn(),
    cancel: vi.fn(),
  }),
}))
vi.mock("../../../src/features/operations/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/operations/operations")>()),
  useBusyLabel: () => "Busy",
}))
const handOff = vi.hoisted(() => vi.fn())
vi.mock("../../../src/features/operations/OperationHandOff", () => ({
  OperationHandOff: (props: { until?: string; onCancel?: () => void }) => {
    handOff(props)
    return (
      <div>
        Working
        {props.onCancel && <button onClick={props.onCancel}>Cancel</button>}
      </div>
    )
  },
}))
vi.mock("../../../src/features/savings/savingsMoveTiming", () => ({
  useSavingsMoveTiming: () => state.timing,
  savingsEtaCopy: (eta: { seconds: number; remaining: boolean }) =>
    `${eta.remaining ? "About" : "Usually about"} ${Math.round(eta.seconds / 60)} min${
      eta.remaining ? " left" : ""
    }`,
}))
vi.mock("../../../src/features/allowance/SponsoredActionNotice", () => ({
  SponsoredActionNotice: () => null,
  useSponsoredActionBlock: () => undefined,
}))
const reported = vi.hoisted(() => vi.fn())
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: reported }))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))
import {
  MoveFundsSheet,
  sharesFor,
  sheetQuote,
} from "../../../src/features/savings/MoveFundsSheet/MoveFundsSheet"

const LINE = { id: "fea-sky", held: { portal: `0x${"5d".repeat(20)}` } } as SavingsLine["line"]
const line = memoryStore<SavingsLine>({
  line: LINE,
  position: null,
  others: [],
  hydrated: true,
})
const setPosition = (
  next: Omit<SavingsPosition, "shareDecimals" | "assetDecimals"> & { assetDecimals?: number },
) =>
  line.set({
    line: LINE,
    position: { assetDecimals: 18, ...next, shareDecimals: 18 },
    others: [],
    hydrated: true,
  })
/** `state.quote`'s figures as the rail's quote: what lands, and the value the burn is worth. */
const railQuote = (q: {
  value: bigint
  net: bigint
  withdrawalFee?: bigint
  feeBeneficiary?: Address
}): MoveQuote => ({
  routed: q.net,
  relayerTip: 0n,
  conversionOut: q.net,
  conversionMinOut: q.net,
  expectedOut: q.value,
  minOut: q.value,
  withdrawalFee: q.withdrawalFee ?? 0n,
  ...(q.feeBeneficiary ? { feeBeneficiary: q.feeBeneficiary } : {}),
})
const moveQuote = (_holding: string, direction: string, amount: bigint) => ({
  read: async () => railQuote(await state.quote(direction, amount)),
  refresh: () => {},
})
/** A burn's record as the burn sequence seeds it, before the burn goes out. */
const SEED = {
  localId: "wdraw_seed",
  networkId: "31337",
  recipient: `0x${"e5".repeat(20)}`,
  recipientProvenance: "saved-recipient",
  amount: "10",
  tokenSymbol: "DAI",
  phase: "submitting",
  startTime: 1,
} as Parameters<Session["withdrawals"]["create"]>[0]
/** The move in a test holds open, as the account's burn would: its operation, and its cancel. */
let building: ((operationId: string, signal?: AbortSignal) => Promise<never>) | undefined
/** The holding each move named, in order. */
let movedHoldings: string[] = []
const moveCommands = {
  add: (holding: string, amount: bigint, operationId: string, _q?: MoveQuote, s?: AbortSignal) => {
    movedHoldings.push(holding)
    return building ? building(operationId, s) : state.move("in", amount)
  },
  withdraw: (holding: string, amount: bigint) => {
    movedHoldings.push(holding)
    return state.move("out", amount)
  },
}

let host: HTMLDivElement
let root: Root
let session: Session
beforeEach(() => {
  building = undefined
  movedHoldings = []
  session = openTestSession({
    balances: liveBalances(() => ({ main: state.balance, readThisSession: true })),
    savingsLine: line.readonly,
    moveQuote,
    moveCommands,
  })
  setPosition({
    shares: 100n * 10n ** 18n,
    value: 105n * 10n ** 18n,
    sharePrice: 105n * 10n ** 16n,
    rate: 55n * 10n ** 15n,
    readAt: 1,
  })
  state.balance = 50n * 10n ** 18n
  limits.cap = 10n ** 30n
  limits.dollars = 10n ** 30n
  state.timing = undefined
  state.savingsMoveEta.mockReset()
  handOff.mockReset()
  reported.mockReset()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  vi.useFakeTimers()
  state.quote.mockReset()
  state.move.mockReset()
  state.quote.mockImplementation(async (direction: string, amount: bigint) => ({
    direction,
    amount,
    value: direction === "in" ? amount : (amount * 105n) / 100n,
    net: (direction === "in" ? amount : (amount * 105n) / 100n) - 2n * ONE,
    fee: 2n * ONE,
  }))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Amount to move"]')!
const type = (value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!
const termsBox = () =>
  host.querySelector<HTMLInputElement>('.ww-savings__terms input[type="checkbox"]')
const accept = () => act(() => termsBox()!.click())
// The debounce, then the quote and the quote of the way back, each a tick of microtasks.
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
  })

describe("MoveFundsSheet", () => {
  it("stops a move in whose fee on top would overspend, and says so with the total", async () => {
    state.balance = 11n * ONE
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(host.textContent).toContain("Balance not enough for the amount plus the fee ($12.00)")
    expect(button("Review").disabled).toBe(true)
  })

  it("stops a move in whose fee keeps rising past the typed amount", async () => {
    let fee = 2n * ONE
    state.quote.mockImplementation(async (direction: string, amount: bigint) => {
      fee += ONE
      return { direction, amount, value: amount, net: amount - fee, fee }
    })
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(button("Review").disabled).toBe(true)
  })

  it("applies Main's withdrawal limit to the amount plus the fee", async () => {
    limits.dollars = 11n * ONE
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(host.querySelector('[data-testid="limit-notice"]')?.textContent).toContain(
      "Over the limit",
    )
    expect(button("Review").disabled).toBe(true)
  })

  it("moves out in shares worth the typed dollars, and every share for MAX", async () => {
    // A position worth $714.287899…: MAX shows the cents, rounded down, and takes every share.
    setPosition({
      shares: 700n * ONE,
      value: 714287899390558444472n,
      sharePrice: 714287899390558444472n / 700n,
      rate: 55n * 10n ** 15n,
      readAt: 1,
    })
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    expect(host.textContent).toContain("Move to Main Account")
    expect(host.textContent).toContain("Available: $714.28")
    act(() => button("MAX").click())
    await settle()
    expect(input().value).toBe("714.28")
    expect(host.textContent).toContain("$714.28")
    expect(host.textContent).not.toContain("Use up to 2 decimal places")
    expect(state.quote).toHaveBeenLastCalledWith("out", 700n * ONE)
    expect(button("Review").disabled).toBe(false)
    // An edited amount takes the shares its dollars are worth.
    type("21")
    await settle()
    expect(state.quote).toHaveBeenLastCalledWith(
      "out",
      (21n * ONE * 700n * ONE) / 714287899390558444472n,
    )
  })

  it("sizes a move out of a vault of a 6-decimal asset in dollars", async () => {
    // 100 shares worth 105.50 USDC.
    setPosition({
      shares: 100n * ONE,
      value: 105_500_000n,
      sharePrice: 1_055_000n,
      readAt: 1,
      assetDecimals: 6,
    })
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    act(() => button("MAX").click())
    await settle()
    expect(input().value).toBe("105.5")
    expect(state.quote).toHaveBeenLastCalledWith("out", 100n * ONE)
    type("21.1")
    await settle()
    expect(state.quote).toHaveBeenLastCalledWith("out", 20n * ONE)
  })

  it("moves in the whole DAI balance for MAX, past the cent the field shows", async () => {
    state.balance = 50n * ONE + (129999n * ONE) / 1_000_000n
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    act(() => button("MAX").click())
    await settle()
    expect(input().value).toBe("50.12")
    // The way back is quoted after it, so this is not the last call.
    expect(state.quote).toHaveBeenCalledWith("in", state.balance)
    act(() => button("Review").click())
    accept()
    await act(async () => button("Confirm move").click())
    expect(state.move).toHaveBeenCalledWith("in", state.balance)
  })

  it("refuses more than the balance and swaps direction in place", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("60")
    await settle()
    expect(host.textContent).toContain("Balance not enough")
    expect(state.quote).not.toHaveBeenCalled()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Swap direction"]')!.click())
    await settle()
    expect(host.textContent).toContain("Available: $105.00")
    expect(state.quote).toHaveBeenCalledWith("out", expect.any(BigInt))
  })

  describe("with shares in a vault the profile no longer lists", () => {
    const OLD = { ...LINE!, id: "fea-sky-old", exitOnly: true } as NonNullable<SavingsLine["line"]>
    beforeEach(() => {
      const first = line.get().position
      const position = { ...first!, shares: 20n * ONE, value: 21n * ONE }
      const ledger = { basis: 0n, counted: 0, shares: 0n, excluded: [] }
      line.set({ ...line.get(), others: [{ line: OLD, position, ledger }] })
    })

    it("moves out of that vault first, up to what it holds", async () => {
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      expect(host.textContent).toContain(usdAtomicFloor(21n * ONE))
      type("10")
      await settle()
      act(() => button("Review").click())
      await act(async () => button("Confirm move").click())
      expect(movedHoldings).toEqual([OLD.id])
    })

    it("takes a move that vault cannot cover from the first line", async () => {
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      type("50")
      await settle()
      act(() => button("Review").click())
      await act(async () => button("Confirm move").click())
      expect(movedHoldings).toEqual([LINE!.id])
    })

    it("still moves in to the first line, and lets the direction swap", async () => {
      act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
      const swap = host.querySelector<HTMLButtonElement>('button[aria-label="Swap direction"]')!
      expect(swap.disabled).toBeFalsy()
      type("10")
      await settle()
      act(() => button("Review").click())
      accept()
      await act(async () => button("Confirm move").click())
      expect(movedHoldings).toEqual([LINE!.id])
    })
  })

  it("only lets an exit-only line's shares leave, however it was opened", async () => {
    const position = line.get().position
    line.set({ line: { ...LINE!, exitOnly: true }, position, others: [], hydrated: true })
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    const swap = host.querySelector<HTMLButtonElement>('button[aria-label="Swap direction"]')!
    expect(swap.disabled).toBe(true)
    type("21")
    await settle()
    act(() => button("Review").click())
    await act(async () => button("Confirm move").click())
    expect(state.move).toHaveBeenCalledWith("out", expect.any(BigInt))
  })
})

describe("sheetQuote", () => {
  it("shows a vault's 6-decimal asset in dollars beside the DAI it moves", () => {
    // In: 800 DAI burned, 799.37 USDC converted for the vault.
    expect(
      sheetQuote("in", 800n * ONE, railQuote({ value: 760n * ONE, net: 799_370_000n }), 6),
    ).toMatchObject({ value: 800n * ONE, net: (79_937n * ONE) / 100n, fee: (63n * ONE) / 100n })
    // Out: 760 shares redeem 798 USDC, converted to 797.50 DAI.
    expect(
      sheetQuote(
        "out",
        760n * ONE,
        railQuote({ value: 798_000_000n, net: (7975n * ONE) / 10n }),
        6,
      ),
    ).toMatchObject({ value: 798n * ONE, net: (7975n * ONE) / 10n, fee: ONE / 2n })
  })
})

describe("sharesFor", () => {
  it("prices dollars in shares at the position's rate, capping at every share", () => {
    const position = { shares: 100n, value: 105n }
    expect(sharesFor(position, 21n)).toBe(20n)
    expect(sharesFor(position, 105n)).toBe(100n)
    expect(sharesFor(position, 200n)).toBe(100n)
    expect(sharesFor({ shares: 0n, value: 0n }, 5n)).toBe(0n)
  })
})

describe("MoveFundsSheet, notes", () => {
  it("shows the fee loading while a quote is in flight, and holds Review until it lands", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    expect(host.textContent).toContain("L1 fee$--")
    expect(host.querySelector('[data-testid="spinner"]')).toBeNull()
    type("10")
    expect(host.textContent).toContain("Getting fee…")
    expect(host.querySelector('[data-testid="spinner"]')).not.toBeNull()
    expect(host.textContent).not.toContain("$--")
    expect(button("Review").disabled).toBe(true)
    await settle()
    expect(host.textContent).not.toContain("Getting fee…")
    expect(host.querySelector('[data-testid="spinner"]')).toBeNull()
    expect(host.textContent).toContain("L1 fee$2.00")
    expect(button("Review").disabled).toBe(false)
  })

  it("names the protocol fee within the L1 fee, and who it pays, on both steps", async () => {
    const beneficiary = `0x${"be".repeat(20)}` as Address
    const quoted = state.quote.getMockImplementation()!
    state.quote.mockImplementation(async (direction: string, amount: bigint) => ({
      ...(await quoted(direction, amount)),
      withdrawalFee: direction === "in" ? ONE / 4n : 0n,
      feeBeneficiary: beneficiary,
    }))
    const note = () => host.querySelector(".ww-withdraw__fee-note")
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(note()?.textContent).toContain("$0.25")
    expect(note()?.querySelector("[title]")?.getAttribute("title")).toBe(beneficiary)
    act(() => button("Review").click())
    expect(note()?.textContent).toContain("$0.25")
    act(() => root.render(null))
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    type("10")
    await settle()
    expect(button("Review").disabled).toBe(false)
    expect(note()).toBeNull()
  })
})

describe("MoveFundsSheet, confirm step", () => {
  const review = async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    act(() => button("Review").click())
  }

  it("holds Confirm on a move in until the terms are accepted, and links all three", async () => {
    await review()
    expect(host.textContent).toContain("Confirm you have read and accept the terms")
    const links = [...host.querySelectorAll<HTMLAnchorElement>(".ww-savings__terms a")]
    expect(links.map((a) => a.href)).toEqual([
      "https://docs.zk.money/terms",
      "https://docs.sky.money/legal/skybase-international/terms-of-use",
      "https://docs.sky.money/legal/skybase-international/user-risks",
    ])
    expect(links.every((a) => a.target === "_blank")).toBe(true)
    expect(button("Confirm move").disabled).toBe(true)
    await act(async () => button("Confirm move").click())
    expect(state.move).not.toHaveBeenCalled()
    accept()
    expect(button("Confirm move").disabled).toBe(false)
    act(() => termsBox()!.click())
    expect(button("Confirm move").disabled).toBe(true)
  })

  it("cancels a move while it builds, and comes back to the review", async () => {
    // As the account's burn refuses one cancelled before it proves.
    building = (_operationId, signal) =>
      new Promise<never>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new WalletError("aborted", "Cancelled"))),
      )
    await review()
    accept()
    await act(async () => button("Confirm move").click())
    await act(async () => button("Cancel").click())
    expect(button("Confirm move")).toBeTruthy()
    expect(reported).not.toHaveBeenCalled()
  })

  it("shows a failure that follows a cancel taken too late to stop the burn", async () => {
    building = (_operationId, signal) =>
      new Promise<never>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new WalletError("move.overspent"))),
      )
    await review()
    accept()
    await act(async () => button("Confirm move").click())
    await act(async () => button("Cancel").click())
    expect(reported).toHaveBeenCalledTimes(1)
  })

  it("withholds the cancel once the move's burn is seeded: it is past stopping", async () => {
    let operationId = ""
    building = (id) => {
      operationId = id
      return new Promise<never>(() => {})
    }
    await review()
    accept()
    await act(async () => button("Confirm move").click())
    expect(button("Cancel")).toBeTruthy()
    await act(async () => {
      await session.withdrawals.create({ ...SEED, operationId })
    })
    expect(button("Cancel")).toBeUndefined()
  })

  it("forgets the acceptance when the sheet is closed and opened again", async () => {
    await review()
    accept()
    expect(button("Confirm move").disabled).toBe(false)
    act(() => root.unmount())
    root = createRoot(host)
    await review()
    expect(termsBox()!.checked).toBe(false)
    expect(button("Confirm move").disabled).toBe(true)
  })
})
