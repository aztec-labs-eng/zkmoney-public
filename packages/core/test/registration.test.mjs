import assert from "node:assert/strict"
import { test } from "node:test"
import { goldenTicketQuote, registrationFloor } from "../dist/constants/index.js"

const dai = (n) => BigInt(Math.round(n * 100)) * 10n ** 16n
const CUT = dai(0.1)

test("the minimum binds the floor while it exceeds the cut", () => {
  assert.equal(registrationFloor({ min: dai(9.5), fee: dai(4.9) }, CUT), dai(14.4))
  assert.equal(registrationFloor({ min: dai(4.4), fee: dai(0.5) }, CUT), dai(4.9))
})

test("the cut binds the floor once the minimum falls to it", () => {
  assert.equal(registrationFloor({ min: dai(0.1), fee: dai(0.5) }, CUT), dai(0.6) + 1n)
  assert.equal(registrationFloor({ min: 0n, fee: dai(0.5) }, CUT), dai(0.6) + 1n)
})

test("a minimum one wei over the cut is the one that binds", () => {
  const min = CUT + 1n
  assert.equal(registrationFloor({ min, fee: dai(0.5) }, CUT), dai(0.5) + min)
})

const TIPS = { relayerTip: dai(0.1), proverTip: dai(1), bridgeRemainder: dai(0.01) }
const ticket = (min, withdrawalCut, depositCut) =>
  goldenTicketQuote({ min, fee: dai(0.5) }, { ...TIPS, withdrawalCut, depositCut })

test("a ticket burn funds both portal cuts and returns the remainder", () => {
  const quote = ticket(0n, CUT, CUT)
  assert.equal(quote.sipaTarget, dai(0.61))
  assert.equal(quote.burn, dai(1.81))
  assert.equal(quote.returned, dai(0.01))
})

test("a zero cut on both legs burns the fee, the remainder and the tips", () => {
  const quote = ticket(0n, 0n, 0n)
  assert.equal(quote.burn, dai(1.61))
  assert.equal(quote.returned, dai(0.01))
})

test("a minimum above the cut is funded once, not on top of the cut", () => {
  const quote = ticket(dai(1), CUT, CUT)
  assert.equal(quote.sipaTarget, dai(1.5))
  assert.equal(quote.burn, dai(2.7))
  assert.equal(quote.returned, dai(0.9))
})

test("unequal cuts price each leg on its own", () => {
  const quote = ticket(0n, dai(0.25), CUT)
  assert.equal(quote.sipaTarget, dai(0.61))
  assert.equal(quote.burn, dai(1.96))
  assert.equal(quote.returned, dai(0.01))
  const deposit = ticket(0n, CUT, dai(0.25))
  assert.equal(deposit.sipaTarget, dai(0.76))
  assert.equal(deposit.burn, dai(1.96))
  assert.equal(deposit.returned, dai(0.01))
})

test("the floor binds the target once the remainder falls under one wei over the cut", () => {
  const quote = goldenTicketQuote(
    { min: 0n, fee: dai(0.5) },
    { ...TIPS, bridgeRemainder: 0n, withdrawalCut: CUT, depositCut: CUT },
  )
  assert.equal(quote.sipaTarget, dai(0.6) + 1n)
  assert.equal(quote.returned, 1n)
})
