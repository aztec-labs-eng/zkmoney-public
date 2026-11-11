// @vitest-environment node
/** A route's fee: the direct route off the executor alone, the floor it sets, and when it settles. */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { formatUnits, type Address } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  ProtocolFeeNote,
  directQuote,
  settledFloor,
  swapTipIsHigh,
  withdrawalFeeDisplay,
  type WithdrawalQuoteState,
} from "../../../src/features/withdraw/withdrawQuote"

const TIP = 3n * 10n ** 18n
/** The source executor's withdrawal fee. */
const FEE = 10n ** 17n
/** What every route takes before its own tips: the executor's fee and the release's relayer tip. */
const RELEASE = FEE + WITHDRAW_RELAYER_TIP
const fee = (swapRelayerTip = TIP) => ({
  withdrawalFee: FEE,
  withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
  swapRelayerTip,
  proverTip: 0n,
  floorAtomic: RELEASE + swapRelayerTip,
})

describe("directQuote", () => {
  const executor = { status: "ready", value: { fee: FEE }, refreshing: false } as const

  it("prices the direct route off the executor's fee, its tips and the typed amount", () => {
    expect(directQuote(executor, 2n, 5n)).toEqual({
      status: "ready",
      fee: {
        withdrawalFee: FEE,
        withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
        swapRelayerTip: 0n,
        proverTip: 2n,
        floorAtomic: RELEASE + 2n,
      },
      estimate: { amountOut: 5n, decimals: 18 },
    })
  })

  it("loads while the executor is read, and closes without one or once its read failed", () => {
    expect(directQuote({ status: "pending" }, 0n, 5n)).toEqual({ status: "loading" })
    expect(directQuote({ status: "failed", error: new Error("rpc") }, 0n, 5n)).toEqual({
      status: "unavailable",
    })
    expect(directQuote(null, 0n, 5n)).toEqual({ status: "unavailable" })
  })
})

describe("swap fee helpers", () => {
  const priced: WithdrawalQuoteState = { status: "ready", fee: fee() }

  it("states the whole floor, and nothing until the route is priced", () => {
    expect(withdrawalFeeDisplay({ status: "loading" })).toBeUndefined()
    expect(withdrawalFeeDisplay({ status: "unavailable" })).toBeUndefined()
    expect(withdrawalFeeDisplay(priced)).toBe(formatUnits(RELEASE + TIP, 18))
  })

  it("flags a tip above 20% of the amount, and only with both figures known", () => {
    expect(swapTipIsHigh(priced, TIP * 5n)).toBe(false)
    expect(swapTipIsHigh(priced, TIP * 5n - 1n)).toBe(true)
    expect(swapTipIsHigh(priced, undefined)).toBe(false)
    expect(swapTipIsHigh({ status: "loading" }, 1n)).toBe(false)
  })
})

describe("settledFloor", () => {
  const cent = 10n ** 16n

  it("keeps the floor the burn carries while the quote stays within a cent of it", () => {
    const floor = 335n * cent
    expect(settledFloor(floor, floor + 1n)).toBe(floor)
    expect(settledFloor(floor, floor - 1n)).toBe(floor)
    expect(settledFloor(floor, floor + cent - 1n)).toBe(floor)
  })

  it("follows a fee that moved by a cent or more", () => {
    const floor = 335n * cent
    expect(settledFloor(floor, floor + cent)).toBe(floor + cent)
    expect(settledFloor(floor, floor - cent)).toBe(floor - cent)
  })

  it("keeps the floor while the route is unpriced", () => {
    expect(settledFloor(335n * cent, undefined)).toBe(335n * cent)
    expect(settledFloor(0n, undefined)).toBe(0n)
  })
})

describe("ProtocolFeeNote", () => {
  const BENEFICIARY = `0x${"fe".repeat(20)}` as Address
  const note = (fee: bigint) =>
    renderToStaticMarkup(createElement(ProtocolFeeNote, { fee, beneficiary: BENEFICIARY }))

  it("names who receives the executor's fee", () => {
    expect(note(FEE)).toContain(`title="${BENEFICIARY}"`)
  })

  it("shows nothing when the executor charges no fee", () => {
    expect(note(0n)).toBe("")
  })
})
