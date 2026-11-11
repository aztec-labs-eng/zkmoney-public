// @vitest-environment node
/**
 * The send-from-wallet sheet's Send over a wallet Store the test writes and a fake transfer: the
 * chain switch it folds in, and where each stop before a transfer leaves the sheet.
 */
import { describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { createPace } from "@obsidion/core/cadence"
import { WalletError } from "@obsidion/core/errors"
import { admitDeposit, memoryStore, NOMINAL_USD_VALUATION } from "@obsidion/front-core"
import type { L1WalletView } from "../../../src/session/l1Wallet"
import { createWalletPrompt } from "../../../src/session/walletPrompt"
import {
  SWITCH_WAIT_MS,
  openFundFlow,
  type FundInputs,
} from "../../../src/features/deposit/DepositFromWalletModal/fundFromWalletFlow"
import {
  fundStart,
  fundTransition,
} from "../../../src/features/deposit/DepositFromWalletModal/fundFromWalletTransition"
import { selectFeeChanged, selectShortfall } from "../../../src/features/deposit/fundFromWalletView"
import { FundingPreflightError } from "../../../src/features/deposit/fundingPreflight"
import { InsufficientL1BalanceError } from "../../../src/features/deposit/l1DepositTokenBalance"
import { DesktopSendUnresolvedError } from "../../../src/platform/desktopBridge"
import type { FundDepositParams } from "../../../src/features/deposit/fundDeposit"
import type { DepositTokenOption } from "../../../src/features/sipa/loadDepositFacts"

const ACCOUNT = `0x${"a1".repeat(20)}` as Hex
const TOKEN = `0x${"da".repeat(20)}` as Hex
const token = {
  address: TOKEN,
  symbol: "DAI",
  decimals: 18,
  icon: "",
  settlesIn: TOKEN,
  swapped: false,
} as DepositTokenOption
/** 2 DAI to receive at a 0.25 fee, within every limit. */
const admission = admitDeposit(
  { token, depositFeeAtomic: 25n * 10n ** 16n, minimumAtomic: 10n ** 18n },
  {
    landedAtomic: 225n * 10n ** 16n,
    gross: { atomic: 225n * 10n ** 16n, decimals: 18, valuation: NOMINAL_USD_VALUATION },
  },
)
const balance = { raw: 10n ** 18n, value: 1, decimals: 18, symbol: "DAI", display: "1" }

function world(fundDeposit: (params: FundDepositParams) => Promise<unknown>, chainId = 1) {
  const view = memoryStore<L1WalletView>({
    account: ACCOUNT,
    accounts: [ACCOUNT],
    chainId,
    walletName: "Rabby",
    connecting: false,
    reopening: false,
  })
  const pace = createPace({ signalled: true })
  const switchNetwork = vi.fn(async () => true)
  const report = vi.fn()
  const callbacks = {
    onApproving: vi.fn(async () => {}),
    onNotApproved: vi.fn(),
    onSent: vi.fn(),
    onSendFailed: vi.fn(),
    onSendUnresolved: vi.fn(),
    onFeeChanged: vi.fn(),
  }
  let clock = 0
  const inputs = (): FundInputs => ({
    canSubmit: view.get().chainId === 1,
    wrongChain: view.get().chainId !== 1,
    transfer: { charged: "2.25", amountAtomic: 2n * 10n ** 18n, admission },
    account: ACCOUNT,
    walletName: "Rabby",
    balance,
    deposit: { address: `0x${"5e".repeat(20)}`, name: "alice.oxide.eth" },
    token,
    fee: "0.25",
    payee: undefined,
    mint: false,
    ...callbacks,
  })
  const flow = openFundFlow(
    {
      l1Wallet: { view: view.readonly, switchNetwork },
      walletPrompt: createWalletPrompt(),
      pace,
      now: () => clock,
      chainId: 1,
      fundDeposit,
      report,
    },
    inputs,
  )
  const sheet = new AbortController()
  flow.start(sheet.signal)
  flow.review("0.25")
  return {
    flow,
    view,
    pace,
    switchNetwork,
    report,
    callbacks,
    sheet,
    tick: (ms: number) => {
      clock += ms
      pace.wake()
    },
  }
}

/** Lets the flow's awaits settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("Send on the wrong chain", () => {
  it("switches the wallet's chain, waits for the wallet to report it, then transfers", async () => {
    const fundDeposit = vi.fn(async () => ({}))
    const { flow, view, switchNetwork } = world(fundDeposit, 8453)
    const sending = flow.send()
    await settle()
    expect(switchNetwork).toHaveBeenCalledWith(1)
    expect(flow.state.get().phase).toBe("switched")
    expect(fundDeposit).not.toHaveBeenCalled()

    view.set({ ...view.get(), chainId: 1 })
    await sending
    expect(fundDeposit).toHaveBeenCalledOnce()
  })

  it("says to switch by hand when the wallet never reports the chain", async () => {
    const fundDeposit = vi.fn(async () => ({}))
    const { flow, tick } = world(fundDeposit, 8453)
    const sending = flow.send()
    await settle()
    tick(SWITCH_WAIT_MS)
    await sending
    expect(fundDeposit).not.toHaveBeenCalled()
    expect(flow.state.get()).toMatchObject({ phase: "ready", note: { switchFailed: true } })
  })

  it("goes back to the review when the wallet refuses the switch", async () => {
    const fundDeposit = vi.fn(async () => ({}))
    const { flow, switchNetwork } = world(fundDeposit, 8453)
    switchNetwork.mockResolvedValueOnce(false)
    await flow.send()
    expect(flow.state.get()).toMatchObject({ phase: "ready", note: undefined })
  })

  it("stops waiting once the sheet closes", async () => {
    const fundDeposit = vi.fn(async () => ({}))
    const { flow, sheet } = world(fundDeposit, 8453)
    const sending = flow.send()
    await settle()
    sheet.abort()
    await sending
    expect(fundDeposit).not.toHaveBeenCalled()
  })
})

describe("a send that stops before any transfer", () => {
  it("names a hold refusal by its code on the form", async () => {
    const { flow } = world(async () => {
      throw new WalletError("deposit.sendHeld")
    })
    await flow.send()
    expect(flow.state.get()).toMatchObject({ phase: "form", note: { code: "deposit.sendHeld" } })
    flow.typed()
    expect(flow.state.get().note).toBeUndefined()
  })

  it("keeps the wallet's reported balance on the form until a later read", async () => {
    const short = { ...balance, raw: 10n ** 17n }
    const { flow } = world(async () => {
      throw new InsufficientL1BalanceError(short)
    })
    await flow.send()
    expect(flow.state.get().phase).toBe("form")
    expect(selectShortfall(flow.state.get(), balance)).toBe(short)
    expect(selectShortfall(flow.state.get(), { ...balance })).toBeUndefined()
  })

  it("returns to the review with the new fee flagged, and asks the caller to read it again", async () => {
    const { flow, callbacks } = world(async () => {
      throw new FundingPreflightError("quote-changed", "fee moved")
    })
    await flow.send()
    expect(callbacks.onFeeChanged).toHaveBeenCalledOnce()
    expect(selectFeeChanged(flow.state.get(), "0.25")).toBe(true)
  })

  it("returns to the review quietly on a wallet rejection", async () => {
    const { flow, report } = world(async () => {
      throw { code: 4001, message: "User rejected the request." }
    })
    await flow.send()
    expect(flow.state.get()).toMatchObject({ phase: "ready", note: undefined })
    expect(report).not.toHaveBeenCalled()
  })

  it("hands an unresolved desktop send to the caller", async () => {
    const { flow, callbacks } = world(async () => {
      throw new DesktopSendUnresolvedError(new Error("timeout"))
    })
    await flow.send()
    expect(callbacks.onSendUnresolved).toHaveBeenCalledOnce()
  })

  it("reports anything else and returns to the review", async () => {
    const broken = new Error("rpc down")
    const { flow, report } = world(async () => {
      throw broken
    })
    await flow.send()
    expect(report).toHaveBeenCalledWith(broken, "deposit:send")
    expect(flow.state.get().phase).toBe("ready")
  })

  it("hands a broadcast transfer to the caller, and its failure after that", async () => {
    const broken = new Error("reverted")
    const { flow, callbacks, report } = world(async (params) => {
      params.onSubmitted?.(`0x${"12".repeat(32)}`)
      throw broken
    })
    await flow.send()
    expect(callbacks.onSent).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: `0x${"12".repeat(32)}`, amount: "2.25" }),
    )
    expect(callbacks.onSendFailed).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(broken, "deposit:confirm")
  })
})

describe("fundTransition", () => {
  it("counts a fee first read on the review as no change, and a later one as a change", () => {
    const s = fundTransition(fundStart(undefined, undefined), { type: "review", fee: undefined })
    expect(selectFeeChanged(s, "0.25")).toBe(false)
    const entered = fundTransition(s, { type: "review", fee: "0.25" })
    expect(selectFeeChanged(entered, "0.30")).toBe(true)
    expect(selectFeeChanged(fundTransition(entered, { type: "back" }), "0.30")).toBe(false)
  })
})
