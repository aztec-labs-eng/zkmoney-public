/**
 * Guards the move sheet decides: no move past the balance, the fee or the limit, MAX leaves no
 * dust, and no move in before its quote and terms.
 */
import { act, type ReactNode } from "react"
import type { Address } from "viem"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { liveBalances } from "../../support/balances"
import { memoryStore, WalletError, type HoldingLine, type MoveQuote } from "@obsidion/front-core"
import type {
  SavingsLine,
  SavingsLineFigures,
  SavingsPosition,
} from "../../../src/features/savings/savingsLine"
import type { Session } from "../../../src/session/session"
import { usdAtomic, usdAtomicFloor } from "../../../src/ui/format"
import { defaultConfig } from "../../support/page"
import { openTestSession } from "../../support/session"

const ONE = 10n ** 18n
const NO_READS: ReadonlyMap<string, number> = new Map()
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
vi.mock("../../../src/features/savings/savingsMoveTiming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/savings/savingsMoveTiming")>()),
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
  vaultSwapSheetQuote,
} from "../../../src/features/savings/MoveFundsSheet/MoveFundsSheet"

const LINE = { id: "fea-sky", held: { portal: `0x${"5d".repeat(20)}` } } as HoldingLine
const TERMS = ["https://vault.example/terms", "https://vault.example/risks"]
const WORDS = {
  rateName: "Vault Rate",
  yieldFrom: "Lending",
  moveBack: "Any time",
  risk: "Contract risk",
  provider: "Vault",
  terms: TERMS.map((url, i) => ({ label: `Terms ${i}`, url })),
}
const LEDGER = { basis: 0n, counted: 0, shares: 0n, excluded: [] }
const figures = (held: HoldingLine, position: SavingsPosition | null): SavingsLineFigures => ({
  line: held,
  ...(position ? { shares: position.shares } : {}),
  position,
  ledger: LEDGER,
})
const line = memoryStore<SavingsLine>({
  lines: [figures(LINE, null)],
  hydrated: true,
  sharesReadAt: NO_READS,
})
const setPosition = (
  next: Omit<SavingsPosition, "shareDecimals" | "assetDecimals"> & { assetDecimals?: number },
) =>
  line.set({
    lines: [figures(LINE, { assetDecimals: 18, ...next, shareDecimals: 18 })],
    hydrated: true,
    sharesReadAt: NO_READS,
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
/** The page a test opens with: `words` stands in for it until the test ends. */
let page: Session["page"]
/** The profile's words for each line, in place of the session's. */
const words = (holdingCopy: Record<string, typeof WORDS>) =>
  Object.defineProperty(session, "page", {
    configurable: true,
    value: { ...page, config: { ...page.config, holdingCopy } },
  })
beforeEach(() => {
  building = undefined
  movedHoldings = []
  session = openTestSession({
    balances: liveBalances(() => ({ main: state.balance, readThisSession: true })),
    savingsLine: line.readonly,
    moveQuote,
    moveCommands,
    config: { ...defaultConfig, holdingCopy: { [LINE.id]: WORDS } },
  })
  page = session.page
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
  Object.defineProperty(session, "page", { configurable: true, value: page })
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const input = () => host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
const type = (value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!
const change = () => host.querySelector<HTMLButtonElement>(".zkm-holding-select__change")
const termsBox = () =>
  host.querySelector<HTMLInputElement>('[data-testid="savings-terms"] input[type="checkbox"]')
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

  it("refuses more than the balance", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("60")
    await settle()
    expect(button("Review").disabled).toBe(true)
    expect(state.quote).not.toHaveBeenCalled()
  })

  describe("with funds in vaults it can swap between", () => {
    const vaultLine = (id: string, byte: string) =>
      ({ id, held: { portal: `0x${byte.repeat(20)}` } } as HoldingLine)
    const [A, B, C] = [vaultLine("fea-a", "aa"), vaultLine("fea-b", "bb"), vaultLine("fea-c", "cc")]
    /** Each vault's rate, which its card shows: B's alone is 7.2%. */
    const position = (rate: bigint): SavingsPosition => ({
      shares: 100n * ONE,
      value: 105n * ONE,
      sharePrice: 105n * 10n ** 16n,
      rate,
      readAt: 1,
      assetDecimals: 18,
      shareDecimals: 18,
    })
    const B_RATE = "7.2%"
    const price = {
      sharePrice: 105n * 10n ** 16n,
      shareDecimals: 18,
      shareSymbol: "sv",
      assetDecimals: 18,
      assetSymbol: "USDC",
      readAt: 1,
    }
    const priced = (held: HoldingLine, rate: bigint) => ({
      ...figures(held, position(rate)),
      price: price as SavingsLineFigures["price"],
    })
    /** What every swap lands: a figure whose cents round up but floor down. */
    const LANDS = (99_435n * ONE) / 1000n
    /** The switches quoted, each `from>to`. */
    let swapsQuoted: string[] = []
    const swapQuote = (from: string, to: string, amount: bigint) => {
      swapsQuoted.push(`${from}>${to}`)
      return { read: async () => railQuote({ value: amount, net: LANDS }), refresh: () => {} }
    }
    /** A session where the profile gives words to the vaults in `worded`. */
    const open = (worded: readonly HoldingLine[]) => {
      session = openTestSession({
        balances: liveBalances(() => ({ main: state.balance, readThisSession: true })),
        savingsLine: line.readonly,
        moveQuote,
        moveCommands,
        vaultSwapQuote: swapQuote,
        vaultSwapTargets: memoryStore(
          new Map([
            [A.id, [B.id]],
            [B.id, [C.id]],
            [C.id, []],
          ]),
        ).readonly,
      })
      words(Object.fromEntries(worded.map((held) => [held.id, WORDS])))
    }
    beforeEach(() => {
      swapsQuoted = []
      line.set({
        lines: [
          priced(A, 55n * 10n ** 15n),
          priced(B, 72n * 10n ** 15n),
          priced(C, 30n * 10n ** 15n),
        ],
        hydrated: true,
        sharesReadAt: NO_READS,
      })
      open([A, B, C])
    })
    const changeIn = (side: "from" | "to") =>
      act(() =>
        host.querySelector<HTMLButtonElement>(`[data-testid="move-change-${side}"]`)!.click(),
      )
    const pick = (held: HoldingLine) =>
      act(() => host.querySelector<HTMLButtonElement>(`[data-testid="picker-${held.id}"]`)!.click())
    const to = () => host.querySelector('[data-testid="move-to"]')?.textContent ?? ""

    it("drops a destination the new source cannot swap into, so it does not come back", () => {
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      changeIn("to")
      pick(B)
      expect(to()).toContain(B_RATE)
      changeIn("from")
      pick(B)
      expect(to()).not.toContain(B_RATE)
      changeIn("from")
      pick(A)
      expect(to()).not.toContain(B_RATE)
    })

    it("shows the review the figure the sheet showed for what lands", async () => {
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      changeIn("to")
      pick(B)
      type("100")
      await settle()
      expect(
        `$${host.querySelector<HTMLInputElement>('[data-testid="move-to"] input')!.value}`,
      ).toBe(usdAtomicFloor(LANDS))
      act(() => button("Review").click())
      expect(host.textContent).toContain(usdAtomicFloor(LANDS))
      expect(host.textContent).not.toContain(usdAtomic(LANDS))
    })

    it("blocks a switch into a vault with no words for its terms, whatever the source has", async () => {
      open([A, C])
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      changeIn("to")
      pick(B)
      type("10")
      await settle()
      expect(host.querySelector('[data-testid="move-no-terms"]')).not.toBeNull()
      expect(button("Review").disabled).toBe(true)
      expect(swapsQuoted).toEqual([])
    })

    it("lets a switch out of a vault with no words go into one that has them, on its terms", async () => {
      open([B])
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      changeIn("to")
      pick(B)
      type("10")
      await settle()
      expect(host.querySelector('[data-testid="move-no-terms"]')).toBeNull()
      act(() => button("Review").click())
      expect(button("Confirm move").disabled).toBe(true)
      accept()
      expect(button("Confirm move").disabled).toBe(false)
    })
  })

  describe("with shares in a vault the profile no longer lists", () => {
    const OLD: HoldingLine = { ...LINE, id: "fea-sky-old", exitOnly: true }
    beforeEach(() => {
      const [first] = line.get().lines
      const position = { ...first!.position!, shares: 20n * ONE, value: 21n * ONE }
      line.set({ lines: [first!, figures(OLD, position)], hydrated: true, sharesReadAt: NO_READS })
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

    it("moves out of the vault picked instead, keeping what was typed", async () => {
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      type("50")
      act(() => change()!.click())
      act(() => host.querySelector<HTMLButtonElement>(`[data-testid="picker-${LINE.id}"]`)!.click())
      expect(input().value).toBe("50")
      await settle()
      act(() => button("Review").click())
      await act(async () => button("Confirm move").click())
      expect(movedHoldings).toEqual([LINE.id])
    })

    it("still moves in to the first line, the one vault that takes it", async () => {
      act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
      expect(change()).toBeNull()
      type("10")
      await settle()
      act(() => button("Review").click())
      accept()
      await act(async () => button("Confirm move").click())
      expect(movedHoldings).toEqual([LINE.id])
    })
  })

  describe("beside a second vault", () => {
    const VAULT: HoldingLine = { ...LINE, id: "fea-vault" }
    const withVault = (shares: bigint) => {
      const [first] = line.get().lines
      const position = { ...first!.position!, shares, value: (shares * 105n) / 100n }
      line.set({
        lines: [first!, figures(VAULT, position)],
        hydrated: true,
        sharesReadAt: NO_READS,
      })
    }
    const hint = () => host.querySelector('[data-testid="move-other-vault"]')

    it("points a move out past this vault's value to another vault that holds shares", async () => {
      withVault(50n * ONE)
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      type("120")
      await settle()
      expect(hint()).not.toBeNull()
      expect(button("Review").disabled).toBe(true)
      type("20")
      await settle()
      expect(hint()).toBeNull()
    })

    it("gives no such pointer when no other vault holds shares", async () => {
      withVault(0n)
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      type("120")
      await settle()
      expect(hint()).toBeNull()
      expect(button("Review").disabled).toBe(true)
    })

    it("blocks a move in through a picked vault the profile no longer lists", async () => {
      withVault(50n * ONE)
      line.set({
        ...line.get(),
        lines: line
          .get()
          .lines.map((l) =>
            l.line.id === VAULT.id ? { ...l, line: { ...VAULT, exitOnly: true } } : l,
          ),
      })
      act(() =>
        root.render(<MoveFundsSheet direction="in" holdingId={VAULT.id} onClose={() => {}} />),
      )
      type("10")
      await settle()
      expect(button("Review").disabled).toBe(true)
      expect(state.quote).not.toHaveBeenCalled()
    })

    it("drops the terms accepted for one vault when the review's vault changes", async () => {
      words({ [LINE.id]: WORDS, [VAULT.id]: { ...WORDS, provider: "Other" } })
      act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
      type("10")
      await settle()
      act(() => button("Review").click())
      accept()
      expect(button("Confirm move").disabled).toBe(false)
      // The vault becomes the first listed line, the one a move in with nothing picked goes through.
      const [first] = line.get().lines
      line.set({ ...line.get(), lines: [figures(VAULT, first!.position), first!] })
      await settle()
      expect(termsBox()!.checked).toBe(false)
      expect(button("Confirm move").disabled).toBe(true)
    })
  })

  describe("through a vault the profile gives no words", () => {
    beforeEach(() => {
      words({})
    })

    it("blocks a move in, and says why", async () => {
      act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
      expect(host.querySelector('[data-testid="move-no-terms"]')).not.toBeNull()
      type("10")
      await settle()
      expect(button("Review").disabled).toBe(true)
      expect(state.quote).not.toHaveBeenCalled()
    })

    it("leaves a move out open", async () => {
      act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
      expect(host.querySelector('[data-testid="move-no-terms"]')).toBeNull()
      type("10")
      await settle()
      act(() => button("Review").click())
      await act(async () => button("Confirm move").click())
      expect(state.move).toHaveBeenCalledWith("out", expect.any(BigInt))
    })
  })

  it("only lets an exit-only line's shares leave, however it was opened", async () => {
    const { position } = line.get().lines[0]!
    line.set({
      lines: [figures({ ...LINE, exitOnly: true }, position)],
      hydrated: true,
      sharesReadAt: NO_READS,
    })
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
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

describe("vaultSwapSheetQuote", () => {
  it("takes the shares' worth as what leaves and the destination's 6-decimal intake as what lands", () => {
    // $798 of shares swap into a vault that takes in 797.50 USDC.
    const quote = railQuote({ value: 760n * ONE, net: 797_500_000n })
    expect(vaultSwapSheetQuote(760n * ONE, 798n * ONE, quote, 6)).toMatchObject({
      value: 798n * ONE,
      net: (7975n * ONE) / 10n,
      fee: ONE / 2n,
    })
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
    expect(host.querySelector(".zkm-spinner-icon")).toBeNull()
    type("10")
    expect(host.textContent).toContain("Getting fee…")
    expect(host.querySelector(".zkm-spinner-icon")).not.toBeNull()
    expect(host.textContent).not.toContain("$--")
    expect(button("Review").disabled).toBe(true)
    await settle()
    expect(host.textContent).not.toContain("Getting fee…")
    expect(host.querySelector(".zkm-spinner-icon")).toBeNull()
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

describe("MoveFundsSheet, payback", () => {
  it("warns that a small move in takes long to earn back its fee, on a vault not yet held", async () => {
    const price = { assetDecimals: 18, shareDecimals: 18, sharePrice: ONE, rate: 55n * 10n ** 15n }
    line.set({
      lines: [{ ...figures(LINE, null), price: price as SavingsLineFigures["price"] }],
      hydrated: true,
      sharesReadAt: NO_READS,
    })
    const warning = () => host.querySelector('.ww-withdraw__warning[data-tone="warning"]')
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    // A $2 fee on $10 at 5.5% takes years to earn back.
    type("10")
    await settle()
    expect(warning()).not.toBeNull()
    type("45")
    await settle()
    expect(button("Review").disabled).toBe(false)
    expect(warning()).toBeNull()
  })
})

describe("MoveFundsSheet, confirm step", () => {
  const review = async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    act(() => button("Review").click())
  }

  it("holds Confirm on a move in until the terms are accepted, and links the vault's", async () => {
    await review()
    expect(host.textContent).toContain("Confirm you have read and accept the terms")
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="savings-terms"] a')]
    expect(links.map((a) => a.href)).toEqual(["https://docs.zk.money/terms", ...TERMS])
    expect(links.every((a) => a.target === "_blank")).toBe(true)
    expect(button("Confirm move").disabled).toBe(true)
    await act(async () => button("Confirm move").click())
    expect(state.move).not.toHaveBeenCalled()
    accept()
    expect(button("Confirm move").disabled).toBe(false)
    act(() => termsBox()!.click())
    expect(button("Confirm move").disabled).toBe(true)
  })

  it("names the vault and its provider's terms before every line's shares are read", async () => {
    line.set({ ...line.get(), hydrated: false })
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    expect(host.querySelector(".zkm-holding-select")).not.toBeNull()
    type("10")
    await settle()
    act(() => button("Review").click())
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="savings-terms"] a')]
    expect(links.map((a) => a.href)).toEqual(["https://docs.zk.money/terms", ...TERMS])
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
