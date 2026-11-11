/** The external-wallet pay sheet: which sheet opens, a pay click that waits on a wallet, and the amounts. */
import { describe, expect, it } from "vitest"
import type { RequestInlinePacket } from "@obsidion/front-core"
import type { ConnectedWallet, L1Wallet } from "../../../src/session/l1Wallet"
import { openPayFlow, type PayInputs } from "../../../src/features/requests/payFlow"
import {
  payFixedAmounts,
  payStart,
  payTransition,
} from "../../../src/features/requests/payTransition"
import type { PayStart } from "../../../src/features/requests/payStart"

const WALLET: ConnectedWallet = { account: `0x${"ee".repeat(20)}`, chainId: 1, walletName: "Rabby" }

/** A wallet whose connects wait until the test answers them, the latest one answering last. */
function wallet() {
  const out: ((w: ConnectedWallet | undefined) => void)[] = []
  const l1: Pick<L1Wallet, "connectAnother"> = {
    connectAnother: () => new Promise((resolve) => out.push(resolve)),
  }
  return { l1, answer: (w: ConnectedWallet | undefined, at = out.length - 1) => out[at]!(w) }
}

function setup(inputs: Partial<PayInputs> = {}, start?: PayStart) {
  const w = wallet()
  const live: PayInputs = {
    over: false,
    canFund: false,
    connected: false,
    openPicker: async () => {},
    pickerShown: () => true,
    ...inputs,
  }
  const flow = openPayFlow({ l1Wallet: w.l1, start }, () => live)
  const ended = new AbortController()
  flow.start(ended.signal)
  return { flow, live, ended, ...w }
}

describe("pay with a wallet", () => {
  it("opens the send at once with a wallet connected", async () => {
    const { flow } = setup({ canFund: true, connected: true })
    await flow.pay("fund")
    expect(flow.state.get().sheet).toBe("fund")
  })

  it("connects a wallet first, then opens the send the click asked for", async () => {
    const { flow, answer } = setup()
    const paying = flow.pay("bridge")
    expect(flow.state.get()).toMatchObject({ waiting: "bridge" })
    expect(flow.state.get().sheet).toBeUndefined()
    answer(WALLET)
    await paying
    expect(flow.state.get().sheet).toBe("bridge")
    expect(flow.state.get().waiting).toBeUndefined()
  })

  it("opens nothing for a payment over the limits, before or after the connect", async () => {
    const held = setup({ over: true, canFund: true, connected: true })
    await held.flow.pay("fund")
    expect(held.flow.state.get().sheet).toBeUndefined()

    const { flow, live, answer } = setup()
    const paying = flow.pay("fund")
    live.over = true
    answer(WALLET)
    await paying
    expect(flow.state.get().sheet).toBeUndefined()
    expect(flow.state.get().waiting).toBeUndefined()
  })

  it("opens nothing when the picker closes without a wallet", async () => {
    const { flow, answer } = setup()
    const paying = flow.pay("fund")
    answer(undefined)
    await paying
    expect(flow.state.get().sheet).toBeUndefined()
    expect(flow.state.get().waiting).toBeUndefined()
  })

  it("acts on the latest click only", async () => {
    const { flow, answer } = setup()
    const first = flow.pay("fund")
    const second = flow.pay("bridge")
    answer(undefined, 0)
    await first
    expect(flow.state.get().waiting).toBe("bridge")
    answer(WALLET, 1)
    await second
    expect(flow.state.get().sheet).toBe("bridge")
  })

  it("does nothing once the sheet is gone", async () => {
    const { flow, answer, ended } = setup()
    const paying = flow.pay("fund")
    ended.abort()
    answer(WALLET)
    await paying
    expect(flow.state.get().sheet).toBeUndefined()
  })
})

describe("the origin a sheet belongs on", () => {
  it("keeps the bridge off Ethereum, and the send and the address on it", async () => {
    const { flow } = setup({ canFund: true, connected: true })
    await flow.pay("bridge")
    expect(flow.origin(false)).toBe("kept")
    expect(flow.origin(true)).toBe("closed")
    await flow.pay("fund")
    expect(flow.origin(true)).toBe("kept")
    expect(flow.origin(false)).toBe("closed")
    flow.dispatch({ type: "open", sheet: "address" })
    expect(flow.origin(false)).toBe("closed")
  })
})

describe("payTransition", () => {
  const start: PayStart = {
    request: {} as RequestInlinePacket,
    bridge: {} as NonNullable<PayStart["bridge"]>,
  }

  it("opens a start's bridge, and ends the start once that sheet goes back", () => {
    const opened = payStart(start)
    expect(opened).toMatchObject({ sheet: "bridge", opening: start })
    expect(payTransition(opened, { type: "closed", ended: true }).opening).toBeUndefined()
    // A wallet send's back leaves the start for the bridge's next showing.
    expect(payTransition(opened, { type: "closed" }).opening).toBe(start)
  })

  it("closes the send once sent, and keeps a bridge's own sent state open", () => {
    const fund = payTransition(payStart(undefined), { type: "open", sheet: "fund" })
    expect(payTransition(fund, { type: "sent" })).toMatchObject({ sent: true, sheet: undefined })
    const bridge = payTransition(payStart(undefined), { type: "open", sheet: "bridge" })
    expect(payTransition(bridge, { type: "sent" })).toMatchObject({ sent: true, sheet: "bridge" })
  })

  it("holds a send whose outcome is unknown until the payer pays again", () => {
    const fund = payTransition(payStart(undefined), { type: "open", sheet: "fund" })
    const failed = payTransition(fund, { type: "sendFailed" })
    expect(failed).toMatchObject({ sent: false, unresolved: true, sheet: "fund" })
    const unknown = payTransition(fund, { type: "sendUnresolved" })
    expect(unknown).toMatchObject({ unresolved: true, sheet: undefined })
    expect(payTransition(unknown, { type: "again" }).unresolved).toBe(false)
  })

  it("starts a short bridge over with nothing sent or held", () => {
    const sent = payTransition(payStart(start), { type: "sent" })
    expect(payTransition(sent, { type: "retry" })).toMatchObject({
      sheet: undefined,
      sent: false,
      unresolved: false,
      opening: undefined,
    })
  })
})

describe("payFixedAmounts", () => {
  it("sends a fixed request's amount from a wallet and bridges its gross", () => {
    expect(payFixedAmounts({ amountAtomic: 100n }, { grossAtomic: 125n })).toEqual({
      send: 100n,
      bridge: 125n,
    })
  })

  it("fixes nothing for an open request", () => {
    expect(payFixedAmounts({ amountAtomic: 0n }, { grossAtomic: 0n })).toBeUndefined()
  })
})
