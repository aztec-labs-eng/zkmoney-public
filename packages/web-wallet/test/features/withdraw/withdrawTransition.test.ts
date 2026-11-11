/** The withdraw flow's state changes: steps, the amount, the kept quotes, the review and the burn. */
import { describe, expect, it } from "vitest"
import { getAddress, parseUnits } from "viem"
import { withdrawInitial } from "../../../src/features/withdraw/WithdrawFlow/withdrawFlow"
import {
  withdrawTransition,
  type WithdrawEvent,
  type WithdrawState,
} from "../../../src/features/withdraw/WithdrawFlow/withdrawTransition"
import type { WithdrawPlan } from "../../../src/features/withdraw/withdrawQuoteView"

const RECIPIENT = getAddress(`0x${"11".repeat(20)}`)
const dai = (amount: string) => parseUnits(amount, 18)

const atAmount = () => withdrawInitial({ recipient: RECIPIENT, atAmount: true }, 1)
const run = (s: WithdrawState, ...events: WithdrawEvent[]) => events.reduce(withdrawTransition, s)

const PLAN: WithdrawPlan = {
  recipient: RECIPIENT,
  chainId: 1,
  coin: "DAI",
  amountAtomic: dai("20"),
  gasAtomic: 0n,
  burnAtomic: dai("20"),
  receivedAtomic: dai("19.9"),
  receivedDecimals: 18,
  speed: "standard",
  proverTip: 0n,
  route: {
    kind: "direct",
    quote: { relayerTip: 0n, amountOut: dai("20"), decimals: 18, floorAtomic: dai("0.1") },
  },
  fresh: false,
}

describe("withdrawTransition", () => {
  it("opens at the amount with the entry's recipient chosen", () => {
    const s = atAmount()
    expect(s.history).toEqual(["address", "amount"])
    expect(s.chosen?.recipient).toBe(RECIPIENT)
  })

  it("goes forward, sets the gas step's opening chip, and goes back one step", () => {
    const s = run(atAmount(), { type: "go", step: "gas", gasAtomic: dai("1") })
    expect(s.history.at(-1)).toBe("gas")
    expect(s.gasAtomic).toBe(dai("1"))
    expect(run(s, { type: "back" }).history).toEqual(["address", "amount"])
    expect(run(withdrawInitial({}, 1), { type: "back" }).history).toEqual(["address"])
  })

  it("chooses a recipient, moving on when asked", () => {
    const chosen = { recipient: RECIPIENT, name: "Rainbow" }
    const s = run(withdrawInitial({}, 1), { type: "choose", chosen, then: "amount" })
    expect(s.chosen).toEqual(chosen)
    expect(s.history).toEqual(["address", "amount"])
  })

  it("types an amount, drops MAX and the solve, and MAX takes From back", () => {
    let s = run(atAmount(), { type: "max" })
    expect(s.amount).toEqual({ text: "", side: "from", maxed: true })
    s = run(
      s,
      { type: "typed", text: "5", side: "to" },
      {
        type: "priced",
        solve: { from: dai("5.1"), tries: 0 },
      },
    )
    expect(s.amount).toEqual({ text: "5", side: "to", maxed: false })
    expect(s.solve?.from).toBe(dai("5.1"))
    expect(run(s, { type: "typed", text: "6", side: "to" }).solve).toBeUndefined()
    expect(run(s, { type: "max" }).amount.side).toBe("from")
  })

  it("re-solves a typed To on a new route, and keeps a typed From", () => {
    const solved = run(
      atAmount(),
      { type: "typed", text: "5", side: "to" },
      { type: "priced", solve: { from: dai("5.1"), tries: 1 } },
    )
    const moved = run(solved, { type: "route", chainId: 8453, coin: "USDC" })
    expect(moved.route).toEqual({ chainId: 8453, coin: "USDC" })
    expect(moved.solve).toBeUndefined()
    const typed = run(atAmount(), { type: "typed", text: "5", side: "from" })
    expect(run(typed, { type: "route", chainId: 8453, coin: "USDC" }).amount.text).toBe("5")
  })

  it("sets the gas chip and the speed", () => {
    const s = run(atAmount(), { type: "gas", gasAtomic: 0n }, { type: "speed", speed: "faster" })
    expect(s.gasAtomic).toBe(0n)
    expect(s.speed).toBe("faster")
  })

  it("keeps a bridge answer, its floor and its fee for the route", () => {
    const answer = { below: true as const, floor: dai("2") }
    const s = run(atAmount(), {
      type: "priced",
      bridge: {
        key: "8453:USDC:1",
        floorRoute: "8453:USDC:0",
        floor: dai("2"),
        answer,
        fee: { route: "8453:USDC", fee: dai("0.3") },
      },
    })
    expect(s.bridge).toEqual({ key: "8453:USDC:1", answer })
    expect(s.floor).toEqual({ route: "8453:USDC:0", floor: dai("2") })
    expect(s.lastFee).toEqual({ route: "8453:USDC", fee: dai("0.3") })
  })

  it("flags a fee that moves after the review was entered, until the user goes back", () => {
    const reviewing = run(atAmount(), { type: "enterReview", feeAtomic: dai("0.1") })
    expect(reviewing.review).toEqual({ feeAtomic: dai("0.1"), changed: false })
    expect(run(reviewing, { type: "priced", fee: dai("0.1") }).review.changed).toBe(false)
    const moved = run(reviewing, { type: "priced", fee: dai("0.2") })
    expect(moved.review).toEqual({ feeAtomic: dai("0.2"), changed: true })
    // Back to the old fee is still a change the user has not seen confirmed.
    expect(run(moved, { type: "priced", fee: dai("0.1") }).review.changed).toBe(true)
    const back = run(moved, { type: "back" })
    expect(back.review.changed).toBe(false)
    expect(run(back, { type: "enterReview", feeAtomic: dai("0.2") }).review.changed).toBe(false)
  })

  it("takes a fee first priced on the review as no change, and ignores fees off the review", () => {
    const seeded = run(atAmount(), { type: "enterReview" }, { type: "priced", fee: dai("0.2") })
    expect(seeded.review).toEqual({ feeAtomic: dai("0.2"), changed: false })
    expect(run(atAmount(), { type: "priced", fee: dai("0.2") }).review.feeAtomic).toBeUndefined()
  })

  it("submits to the status, stages, and keeps the record's id", () => {
    let s = run(
      atAmount(),
      { type: "enterReview", feeAtomic: dai("0.1") },
      { type: "submitted", plan: PLAN, chain: "Ethereum" },
    )
    expect(s.history.at(-1)).toBe("status")
    expect(s).toMatchObject({ stage: "building", signing: true, live: true })
    s = run(s, { type: "staged", stage: "proving" }, { type: "signing", signing: false })
    expect(s.stage).toBe("proving")
    expect(s.signing).toBe(false)
    s = run(s, { type: "staged", stage: undefined, localId: "w1" })
    expect(s.stage).toBeUndefined()
    expect(s.sent).toEqual({ plan: PLAN, chain: "Ethereum", localId: "w1" })
  })

  it("returns to the review on a cancel, and with the failure's code on a failure", () => {
    const sent = run(
      atAmount(),
      { type: "enterReview", feeAtomic: dai("0.1") },
      { type: "submitted", plan: PLAN, chain: "Ethereum" },
    )
    const cancelled = run(sent, { type: "cancelled" })
    expect(cancelled.history.at(-1)).toBe("review")
    expect(cancelled.sent).toBeUndefined()
    const failed = run(sent, { type: "failed", code: "withdrawal.failed" })
    expect(failed.history.at(-1)).toBe("review")
    expect(failed.failure).toBe("withdrawal.failed")
  })

  it("retries a failed status from the amount", () => {
    const sent = run(
      atAmount(),
      { type: "enterReview", feeAtomic: dai("0.1") },
      { type: "submitted", plan: PLAN, chain: "Ethereum" },
    )
    const retried = run(sent, { type: "back", to: "amount" })
    expect(retried.history).toEqual(["address", "amount"])
    expect(retried.sent).toBeUndefined()
  })

  it("marks the flow closed", () => {
    expect(run(atAmount(), { type: "closed" }).closed).toBe(true)
  })
})
