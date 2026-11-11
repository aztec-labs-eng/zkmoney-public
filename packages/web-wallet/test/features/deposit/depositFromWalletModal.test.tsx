/** Guards: no send past balance, fee, limit or the row's capacity; one send; a hold saved first. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { formatUnits, parseUnits, type Hex } from "viem"
import {
  createPortalCapacityStore,
  NOMINAL_USD_VALUATION,
  type PortalCapacityStore,
  type UsdValuation,
} from "@obsidion/front-core"
import type { PortalCapacitySnapshot } from "@obsidion/sdk"
import type { L1TokenBalance } from "../../../src/features/deposit/l1DepositTokenBalance"
import type { DepositTokenOption } from "../../../src/features/sipa/loadDepositFacts"
import {
  MAINNET_DAI,
  MAINNET_USDC,
  mainnetTokens,
  mockLoadDepositFacts,
  ROW_USDC,
  tokenOption,
  twoRowTokens,
} from "../../support/depositTokens"
import { fmt } from "../../../src/lib/fmt"
import { tokenFigure } from "../../../src/ui/format"
import sendCopy from "../../../src/features/deposit/sendFromWallet.copy"
import amountCopy from "../../../src/ui/flow/AmountStep/AmountStep.copy"
import flowCopy from "../../../src/ui/flow/flow.copy"
import { LIMIT, LIMIT_USD, typed } from "../../support/publicLimit"
import { testQuery } from "../../support/query"

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Hex
const balanceLine = (figure: string) => `${amountCopy.balance} ${figure}`
const feeLine = (figure: string) => `${flowCopy.fee} ${figure}`
const balance: { current: L1TokenBalance | undefined } = { current: undefined }
const screening = { cleared: true }
type DepositParams = {
  amountDisplay: string
  tokenSymbol: string
  token?: { address: Hex; decimals: number }
  onSubmitted?: (h: Hex) => void
  onStage?: (stage: string) => void
  preflight: (fresh: { feeDisplay: string }) => Promise<void>
  beforeApprove?: (submission: string) => Promise<void>
  record?: boolean
}
const deposit = vi.fn(async (_params: DepositParams) => ({
  txHash: "0x01",
  address: "0xdeadbeef",
  name: "alice",
}))

const useL1TokenBalance = vi.hoisted(() => vi.fn())
const TX_AMOUNT_CAP = vi.hoisted(() => 5166n * 10n ** 18n)
const rowCap = vi.hoisted(() => ({ asked: [] as (string | undefined)[], twoRows: false }))
vi.mock("../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => TX_AMOUNT_CAP,
  useRowTxAmountCap: (rowToken?: string) => {
    rowCap.asked.push(rowToken)
    return TX_AMOUNT_CAP
  },
}))
vi.mock("../../../src/features/deposit/useL1TokenBalance", () => ({ useL1TokenBalance }))
vi.mock("../../../src/ui/screening", () => ({
  useScreenedAddress: () => ({ verdict: undefined, cleared: screening.cleared, rescreen: vi.fn() }),
  ScreeningNotice: () => <span>screening-notice</span>,
}))

const DAI = 10n ** 18n
/** The DAI row's bucket: its token is the one the sheet's credit is metered in. */
const KEY = {
  chainId: 11155111,
  portal: "0x1111111111111111111111111111111111111111",
  token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
} as const
/** What the fake portal reports; each read takes the current values. */
const capacity = vi.hoisted(() => ({
  availableAtomic: 0n,
  fail: false,
  /** Answered reads. */
  reads: 0,
  /** Reads asked for, answered or not. */
  attempts: 0,
  store: undefined as unknown,
  rowTokens: [] as (string | undefined)[],
}))
vi.mock("../../../src/features/deposit/capacityStore", () => ({
  activeCapacityKey: async (_page: unknown, rowToken?: string) => {
    capacity.rowTokens.push(rowToken)
    return {
      chainId: 11155111,
      portal: "0x1111111111111111111111111111111111111111",
      token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    }
  },
  depositCapacityStore: () => capacity.store,
}))
const snapshot = (): PortalCapacitySnapshot => ({
  ...KEY,
  decimals: 18,
  blockNumber: BigInt(++capacity.reads),
  blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  rateAtomicPerSecond: DAI,
  globalLimitAtomic: 50_000n * DAI,
  availableAtomic: capacity.availableAtomic,
  txAmountCapAtomic: TX_AMOUNT_CAP,
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../../../src/features/sipa/loadDepositFacts", (importOriginal) =>
  mockLoadDepositFacts(importOriginal, () => (rowCap.twoRows ? twoRowTokens() : mainnetTokens())),
)
const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent,
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "b",
}))

const { DepositFromWalletModal } = await import(
  "../../../src/features/deposit/DepositFromWalletModal/DepositFromWalletModal"
)
const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
// Not sandbox: the balance ceiling only applies where nothing is minted on the way.
const config = await (await import("../../support/seedBootConfig")).testnetConfig()
beforeEach(() => void openTestSession({ config, fundDeposit: deposit }))
afterEach(closeSession)

const l1 = {
  account: ACCOUNT,
  accounts: [ACCOUNT],
  chainId: 1,
  walletName: "Rainbow",
  connecting: false,
  wrongChain: false,
  connect: async () => {},
  disconnect: () => {},
  switchNetwork: async () => true,
  selectAccount: () => {},
  switchAccount: async () => {},
} as never

const token: DepositTokenOption = mainnetTokens().settlement
const holds = (display: string): L1TokenBalance => ({
  raw: BigInt(Math.round(Number(display) * 1e6)) * 10n ** 12n,
  value: Number(display),
  display: `${display} DAI`,
  symbol: "DAI",
  decimals: 18,
})

let container: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSent = vi.fn()
const onSendFailed = vi.fn()
const onSendUnresolved = vi.fn()
const onFeeChanged = vi.fn()
const onApproving = vi.fn()
const onNotApproved = vi.fn()

async function render(
  fee?: string,
  pick = token,
  /** `null`: no valuation for this token. */
  valuation: UsdValuation | null = NOMINAL_USD_VALUATION,
  paying: { payee?: string; fixedAmount?: string } = {},
  wallet: unknown = l1,
) {
  await act(async () => {
    root.render(
      <DepositFromWalletModal
        l1={wallet as never}
        deposit={{ address: "0xdeadbeef" as Hex, name: "alice" }}
        token={pick}
        fee={fee}
        valuation={valuation ?? undefined}
        onClose={onClose}
        onSent={onSent}
        onSendFailed={onSendFailed}
        onSendUnresolved={onSendUnresolved}
        onFeeChanged={onFeeChanged}
        onApproving={onApproving}
        onNotApproved={onNotApproved}
        {...paying}
      />,
    )
  })
  await settleReads()
}
/** Lets the key lookup and capacity reads land. */
async function settleReads() {
  for (let i = 0; i < 5; i++) await act(async () => {})
}
/** The To field: what lands. The From field shows that plus the fee. */
const receiveInput = () =>
  container.querySelector<HTMLInputElement>('[aria-label="Amount to receive"]')!
const sendInput = () => container.querySelector<HTMLInputElement>('[aria-label="Amount to send"]')!
async function type(value: string) {
  const input = receiveInput()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const button = (title: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)!
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
/** The coin the To side lands as. */
const receiveSymbol = () =>
  Array.from(byTestId("fund-to")?.querySelectorAll("b") ?? []).at(-1)?.textContent
/** Why the last send stopped before any transfer, shown next to the funding action. */
const reason = () => byTestId("funding-action-reason")?.textContent
/** The capacity line's reason; empty while capacity is healthy. */
const capacityReason = () => byTestId("funding-capacity-status")?.textContent

const transfer = vi.fn()
/** A gateway that runs the caller's last check, then "transfers". */
const checkedDeposit = (feeDisplay = "0.5", approval = false) =>
  deposit.mockImplementationOnce(async (params) => {
    await params.preflight({ feeDisplay })
    // The desktop bridge records the approval only once the recheck passed in time.
    if (approval) await params.beforeApprove?.("submission-1")
    transfer(params.amountDisplay)
    params.onSubmitted?.("0xabc")
    return { txHash: "0xabc", address: "0xdeadbeef", name: "alice" }
  })

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  balance.current = holds("10")
  useL1TokenBalance.mockReset().mockImplementation(() => balance.current)
  screening.cleared = true
  deposit.mockClear()
  transfer.mockClear()
  fireEvent.mockClear()
  onClose.mockClear()
  onSent.mockClear()
  onSendFailed.mockClear()
  onSendUnresolved.mockClear()
  onFeeChanged.mockClear()
  onApproving.mockReset()
  onNotApproved.mockClear()
  capacity.availableAtomic = 50_000n * DAI
  capacity.fail = false
  capacity.reads = 0
  capacity.attempts = 0
  capacity.rowTokens = []
  rowCap.asked = []
  rowCap.twoRows = false
  capacity.store = createPortalCapacityStore(KEY, {
    read: () => {
      capacity.attempts++
      if (capacity.fail) return Promise.reject(new Error("rpc down"))
      return Promise.resolve(snapshot())
    },
    query: testQuery(),
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe("DepositFromWalletModal paying someone else", () => {
  const confirm = async () => {
    await act(async () => button("Review").click())
    await act(async () => button(sendCopy.payButton).click())
    await settleReads()
  }

  it("sends exactly a fixed request's amount plus the fee, which the payer cannot change", async () => {
    checkedDeposit()
    await render("0.5", token, NOMINAL_USD_VALUATION, { payee: "river", fixedAmount: "2.25" })
    const input = receiveInput()
    expect(input.value).toBe("2.25")
    expect(input.readOnly).toBe(true)
    expect(sendInput().readOnly).toBe(true)
    await confirm()
    expect(transfer).toHaveBeenCalledWith("2.75")
    expect(deposit.mock.calls[0][0].record).toBe(false)
  })

  it("records the wallet's own deposit", async () => {
    checkedDeposit()
    await render("0.5")
    await type("3")
    await act(async () => button("Review").click())
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    await settleReads()
    expect(deposit.mock.calls[0][0].record).toBe(true)
  })
})

describe("DepositFromWalletModal", () => {
  it("charges amount + fee and blocks when that total exceeds the balance", async () => {
    await render("0.5")
    await type("9.6")
    expect(button("Review").disabled).toBe(true)
    expect(container.textContent).toContain("Not enough funds")
    await type("9.5")
    expect(button("Review").disabled).toBe(false)
    expect(sendInput().value).toBe("10")
  })

  it("shows the wallet balance in the coin, and MAX sends all of it", async () => {
    balance.current = holds("12.34")
    await render("0.5")
    expect(container.textContent).toContain(balanceLine("12.34 DAI"))
    await act(async () => button("MAX").click())
    expect(sendInput().value).toBe("12.34")
    expect(receiveInput().value).toBe("11.84")
    expect(button("Review").disabled).toBe(false)
  })

  it("caps MAX at the published limit", async () => {
    balance.current = holds(String(2 * LIMIT))
    await render("0.5")
    await act(async () => button("MAX").click())
    expect(receiveInput().value).toBe(typed(LIMIT - 0.5))
  })

  it("disables MAX when the balance does not cover the fee", async () => {
    balance.current = holds("0")
    await render("0.5")
    expect(container.textContent).toContain(balanceLine("0 DAI"))
    expect(button("MAX").disabled).toBe(true)
  })

  it("clears a rejected transfer's balance on the next read, even one that reads the same", async () => {
    const { InsufficientL1BalanceError } = await import(
      "../../../src/features/deposit/l1DepositTokenBalance"
    )
    deposit.mockRejectedValueOnce(new InsufficientL1BalanceError(holds("2")))
    await render("0.5")
    await type("5")
    await act(async () => button("Review").click())
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    await settleReads()
    expect(container.textContent).toContain("Not enough funds")
    expect(button("Review").disabled).toBe(true)
    balance.current = holds("10")
    await render("0.5")
    expect(button("Review").disabled).toBe(false)
  })

  it("stays enabled when the balance could not be read", async () => {
    balance.current = undefined
    await render("0.5")
    await type("5")
    expect(button("Review").disabled).toBe(false)
  })

  it("cannot submit until the fee is known", async () => {
    await render(undefined)
    await type("5")
    expect(button("Review").disabled).toBe(true)
  })

  it(`counts the gross send, fee included, against the ${LIMIT_USD} limit and offers the largest amount that fits`, async () => {
    balance.current = holds(String(2 * LIMIT))
    await render("0.5")
    await type(typed(LIMIT - 0.5))
    expect(button("Review").disabled).toBe(false)
    expect(sendInput().value).toBe(String(LIMIT))
    expect(container.querySelector('[data-testid="limit-notice"]')).toBeNull()

    await type(typed(LIMIT - 0.49))
    expect(button("Review").disabled).toBe(true)
    const notice = container.querySelector('[data-testid="limit-notice"]')!
    expect(notice.getAttribute("role")).toBe("alert")
    // Said once: the fields keep their figures instead of repeating the reason.
    for (const note of container.querySelectorAll(
      '[data-testid="fund-from"] small, [data-testid="fund-to"] small',
    ))
      expect(note.textContent).not.toMatch(/limit|maximum/i)

    // The correction is the user's choice, never applied on its own.
    expect(receiveInput().value).toBe(typed(LIMIT - 0.49))
    await act(async () =>
      notice.querySelector<HTMLButtonElement>('[data-testid="limit-notice-use-maximum"]')!.click(),
    )
    expect(receiveInput().value).toBe(typed(LIMIT - 0.5))
    expect(button("Review").disabled).toBe(false)
  })

  it("checks the credit against the protocol ceiling separately from the published limit", async () => {
    // A valuation under a dollar puts the published limit above the ceiling, so only the ceiling
    // stops 5,166.01; the correction names no figure for it.
    const cheap: UsdValuation = { source: "test", usdPerToken: { numerator: 4n, denominator: 10n } }
    balance.current = holds(String(2 * LIMIT))
    await render("0.5", token, cheap)
    await type(formatUnits(TX_AMOUNT_CAP, 18))
    expect(button("Review").disabled).toBe(false)
    await type(`${formatUnits(TX_AMOUNT_CAP, 18)}.01`)
    expect(button("Review").disabled).toBe(true)
    const notice = container.querySelector('[data-testid="limit-notice"]')!
    expect(notice.textContent).toContain("Over the network's maximum per deposit")
    expect(notice.textContent).not.toMatch(/5,?166/)
    await act(async () => button("Use maximum").click())
    expect(receiveInput().value).toBe(formatUnits(TX_AMOUNT_CAP, 18))
  })

  it("refuses to send a token it cannot value against the limit", async () => {
    await render("0.5", token, null)
    expect(container.querySelector('[data-testid="limit-notice"]')!.textContent).toContain(
      `can't be checked against the ${LIMIT_USD} limit`,
    )
    await type("5")
    expect(button("Review").disabled).toBe(true)
  })

  it("counts a 6-decimal token's send in its own units and lands it as the row's coin", async () => {
    const usdcToken = tokenOption("USDC", MAINNET_USDC, 6, MAINNET_DAI)
    balance.current = undefined
    await render("0.5", usdcToken)
    await type(typed(LIMIT - 0.5))
    expect(container.querySelector('[data-testid="limit-notice"]')).toBeNull()
    expect(receiveSymbol()).toBe("DAI")
    expect(byTestId("fund-fee")?.textContent).toBe(feeLine("$0.50"))
    await type(typed(LIMIT - 0.49))
    expect(container.querySelector('[data-testid="limit-notice"]')).not.toBeNull()
  })

  it("says a USDC row credits USDC, in USDC, on its own row's cap and bucket", async () => {
    rowCap.twoRows = true
    const usdcRow = twoRowTokens().options[1]!
    balance.current = undefined
    await render("0.1", usdcRow)
    await type("10")
    expect(byTestId("fund-fee")?.textContent).toBe(feeLine("$0.10"))
    expect(receiveSymbol()).toBe("USDC")
    expect(sendInput().value).toBe("10.1")
    expect(container.textContent).not.toContain("DAI")
    expect(new Set(rowCap.asked)).toEqual(new Set([ROW_USDC]))
    expect(new Set(capacity.rowTokens)).toEqual(new Set([ROW_USDC]))
  })

  it("is gated on the sender clearing screening", async () => {
    screening.cleared = false
    await render("0.5")
    await type("5")
    expect(button("Review").disabled).toBe(true)
    expect(container.textContent).toContain("screening-notice")
  })

  it("confirms before transferring the charged total, and cannot be dismissed mid-transfer", async () => {
    let resolveDeposit!: () => void
    deposit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDeposit = () => resolve({ txHash: "0x01", address: "0xdeadbeef", name: "alice" })
        }),
    )
    await render("0.5")
    await type("2")
    await act(async () => button("Review").click())
    expect(deposit).not.toHaveBeenCalled()
    expect(container.textContent).toContain(fmt(sendCopy.send, { coin: "DAI" }))
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    expect(deposit.mock.calls[0][0]).toMatchObject({ amountDisplay: "2.5", tokenSymbol: "DAI" })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => resolveDeposit())
    // The connected-wallet leg of the deposit funnel: funded is stamped with its funding source.
    expect(fireEvent).toHaveBeenCalledWith(
      "deposit_funded",
      expect.objectContaining({ funding: "wallet" }),
    )
  })

  it("hands off once broadcast and reports a later confirmation failure to the caller", async () => {
    deposit.mockImplementationOnce(async (params) => {
      await params.preflight({ feeDisplay: "0.5" })
      params.onSubmitted?.("0xabc")
      throw new Error("reverted")
    })
    await render("0.5")
    await type("2")
    await act(async () => button("Review").click())
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    // The charged amount is the whole figure the caller needs; the fee is already inside it.
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xabc", amount: "2.5" }))
    expect(onSendFailed).toHaveBeenCalled()
    // A reverted confirmation is a failure, never a funded funnel step.
    expect(fireEvent).not.toHaveBeenCalledWith("deposit_funded", expect.anything())
    expect(fireEvent).toHaveBeenCalledWith(
      "action_failed",
      expect.objectContaining({ action: "deposit:send" }),
    )
  })
})

describe("DepositFromWalletModal shared capacity", () => {
  beforeEach(() => {
    balance.current = holds(String(2 * LIMIT))
  })

  it("blocks 2,000 against 500 of capacity: the reason sits by the action and nothing is requested", async () => {
    capacity.availableAtomic = 500n * DAI
    await render("0.5")
    await type("2000")
    expect(button("Review").disabled).toBe(true)
    expect(capacityReason()).toBe("This deposit needs 2,000 DAI; 500 DAI is available now.")
    // Said once, by the capacity line.
    expect(reason()).toBeUndefined()
    await act(async () => button("Review").click())
    expect(deposit).not.toHaveBeenCalled()
    expect(transfer).not.toHaveBeenCalled()

    // A smaller amount only when the user asks for it.
    expect(receiveInput().value).toBe("2000")
    await act(async () => byTestId("funding-capacity-use-available")!.click())
    expect(receiveInput().value).toBe("500")
    expect(button("Review").disabled).toBe(false)
    // A fit is not a promise: the whole of a low bucket says only that it is low.
    expect(capacityReason()).toBe("Network capacity is low.")
  })

  it("returns to the form, with no transfer, when capacity drops between entry and confirmation", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Review").click())
    // The review keeps to the transfer itself; capacity rules are in the details.
    expect(container.textContent).not.toContain("doesn't reserve capacity")
    capacity.availableAtomic = DAI
    checkedDeposit()
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    await settleReads()
    expect(transfer).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
    expect(button("Review").disabled).toBe(true)
    expect(capacityReason()).toBe("This deposit needs 2 DAI; 1 DAI is available now.")
    expect(reason()).toBeUndefined()
  })

  it("does not call a later capacity drop a failed transfer", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Review").click())
    checkedDeposit()
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    expect(transfer).toHaveBeenCalledWith("2.5")
    capacity.availableAtomic = 0n
    await act(async () => void (capacity.store as PortalCapacityStore).retry())
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xabc" }))
    expect(onSendFailed).not.toHaveBeenCalled()
  })

  it.each([
    [
      "the fee read for the send differs from the one shown",
      async () => {
        checkedDeposit("0.6")
        await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
        expect(transfer).not.toHaveBeenCalled()
        expect(onFeeChanged).toHaveBeenCalledOnce()
      },
    ],
    ["the fee moves on the review", async () => {}],
  ] as const)(
    "stays on the review with the new fee and says so when %s, until the user goes back",
    async (_case, change) => {
      await render("0.5")
      await type("2")
      await act(async () => button("Review").click())
      expect(reason()).toBeUndefined()
      await change()
      await render("0.6")
      const send = button(fmt(sendCopy.send, { coin: "DAI" }))
      expect(send).toBeDefined()
      expect(container.textContent).toContain(tokenFigure("2.6", "DAI"))
      expect(reason()).toBe(sendCopy.progress.feeChanged)

      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click(),
      )
      expect(reason()).toBeUndefined()
      await act(async () => button("Review").click())
      expect(reason()).toBeUndefined()
    },
  )

  it.each([
    [
      "cannot be saved",
      "deposit.holdUnsaved",
      "This browser couldn't save the deposit's progress.",
    ],
    [
      "would replace another send's",
      "deposit.sendHeld",
      "Another deposit from your browser wallet may still be sent.",
    ],
  ] as const)(
    "approves nothing when the hold %s, and returns to the form",
    async (_case, code, note) => {
      const { WalletError } = await import("@obsidion/front-core")
      onApproving.mockImplementation(async () => {
        throw new WalletError(code)
      })
      await render("0.5")
      await type("2")
      await act(async () => button("Review").click())
      checkedDeposit("0.5", true)
      await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
      expect(onApproving).toHaveBeenCalledOnce()
      expect(onApproving).toHaveBeenCalledWith("submission-1")
      expect(transfer).not.toHaveBeenCalled()
      expect(reason()).toBe(note)
    },
  )

  it.each([
    ["the recheck budget ran out", true, "DesktopRecheckTimeoutError"],
    ["the send was approved without a hash", false, "DesktopSendUnresolvedError"],
  ] as const)(
    "when %s, reports the submission as never approved: %s",
    async (_case, notApproved, name) => {
      const desktop = await import("../../../src/platform/desktopBridge")
      onApproving.mockResolvedValue(undefined)
      await render("0.5")
      await type("2")
      await act(async () => button("Review").click())
      deposit.mockImplementationOnce(async (params) => {
        await params.beforeApprove?.("submission-1")
        throw name === "DesktopSendUnresolvedError"
          ? new desktop.DesktopSendUnresolvedError(new Error("no hash"))
          : new desktop.DesktopRecheckTimeoutError()
      })
      await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
      if (notApproved) expect(onNotApproved).toHaveBeenCalledWith("submission-1")
      else expect(onNotApproved).not.toHaveBeenCalled()
    },
  )

  it("does not save a hold when capacity refuses the approval", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Review").click())
    capacity.availableAtomic = DAI
    checkedDeposit("0.5", true)
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    expect(onApproving).not.toHaveBeenCalled()
    expect(transfer).not.toHaveBeenCalled()
  })

  it("hands a possibly funded address back to the caller instead of the form", async () => {
    const { DesktopSendUnresolvedError } = await import("../../../src/platform/desktopBridge")
    await render("0.5")
    await type("2")
    await act(async () => button("Review").click())
    deposit.mockImplementationOnce(async () => {
      throw new DesktopSendUnresolvedError(new Error("Network capacity changed."))
    })
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    expect(onSendUnresolved).toHaveBeenCalledOnce()
    expect(onSendFailed).not.toHaveBeenCalled()
    expect(button("Review")).toBeUndefined()
  })
})

describe("DepositFromWalletModal from mainnet USDC", () => {
  const symbol = "USDC"
  const address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  // Swapped to DAI by the sweep, so the credit capacity meters is not known before the send.
  const pick = tokenOption(symbol, address, 6, MAINNET_DAI)
  const holdsStable = (display: string): L1TokenBalance => ({
    raw: parseUnits(display, 6),
    value: Number(display),
    display: `${display} ${symbol}`,
    symbol,
    decimals: 6,
  })

  beforeEach(() => {
    balance.current = holdsStable(String(2 * LIMIT))
  })

  it("keeps holding an empty bucket when the next read fails", async () => {
    capacity.availableAtomic = 0n
    await render("0.5", pick)
    await type("2")
    expect(capacityReason()).toBe("No network capacity is available right now.")
    capacity.fail = true
    const before = capacity.attempts
    await act(async () => void (capacity.store as PortalCapacityStore).retry())
    expect(capacity.attempts).toBeGreaterThan(before)
    expect((capacity.store as PortalCapacityStore).getState().status).toBe("unavailable")
    expect(button("Review").disabled).toBe(true)
    expect(capacityReason()).toBe("No network capacity is available right now.")
    await act(async () => button("Review").click())
    expect(deposit).not.toHaveBeenCalled()
  })

  it(`keeps the ${LIMIT_USD} limit, the balance and screening`, async () => {
    await render("0.5", pick)
    await type(typed(LIMIT - 0.49))
    expect(button("Review").disabled).toBe(true)
    expect(byTestId("limit-notice")).not.toBeNull()
    await type(typed(LIMIT - 0.5))
    expect(button("Review").disabled).toBe(false)

    balance.current = holdsStable("2")
    await render("0.5", pick)
    await type("2")
    expect(button("Review").disabled).toBe(true)
    expect(container.textContent).toContain("Not enough funds")

    balance.current = holdsStable(String(2 * LIMIT))
    screening.cleared = false
    await render("0.5", pick)
    await type("2")
    expect(button("Review").disabled).toBe(true)
    expect(container.textContent).toContain("screening-notice")
  })
})

describe("DepositFromWalletModal waiting on the wallet", () => {
  const OPEN = "Your wallet still has the previous request open. Approve or reject it there first."
  const note = () => byTestId("wallet-prompt-stall")
  const stall = () => act(async () => vi.advanceTimersByTime(30_000))
  const cancel = () => act(async () => note()!.querySelector("button")!.click())
  /** Reaches the confirm step, then a transfer the wallet holds until the test answers for it. */
  async function toPrompt() {
    await render("0.5")
    await type("2")
    await act(async () => button("Review").click())
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const held = {} as { resolve: (hash: Hex) => void; reject: (e: unknown) => void }
    deposit.mockImplementationOnce(async (params) => {
      params.onStage?.("sending")
      const txHash = await new Promise<Hex>((resolve, reject) =>
        Object.assign(held, { resolve, reject }),
      )
      params.onSubmitted?.(txHash)
      return { txHash, address: "0xdeadbeef", name: "alice" }
    })
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    expect(container.textContent).toContain("Approve the transfer in your wallet")
    return held
  }

  afterEach(() => vi.useRealTimers())

  it("still hands off a hash that arrives after Cancel", async () => {
    const held = await toPrompt()
    await stall()
    await cancel()
    await act(async () => held.resolve("0xabc" as Hex))
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xabc" }))
    expect(fireEvent).toHaveBeenCalledWith(
      "deposit_funded",
      expect.objectContaining({ funding: "wallet" }),
    )
  })

  it("swallows a rejection that arrives after Cancel", async () => {
    const { showReportableError } = await import("../../../src/errors/errorModal")
    vi.mocked(showReportableError).mockClear()
    const held = await toPrompt()
    await stall()
    await cancel()
    await act(async () => held.reject(new Error("wallet closed")))
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
    expect(onSendFailed).not.toHaveBeenCalled()
    expect(button("Send DAI").disabled).toBe(false)
  })

  it("refuses a second confirm while the wallet still holds the first request", async () => {
    await toPrompt()
    await stall()
    await cancel()
    await act(async () => button(fmt(sendCopy.send, { coin: "DAI" })).click())
    expect(deposit).toHaveBeenCalledTimes(1)
    expect(reason()).toBe(OPEN)
    expect(button("Send DAI").disabled).toBe(false)
  })
})
