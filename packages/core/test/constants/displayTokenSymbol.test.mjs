import assert from "node:assert/strict"
import { test } from "node:test"
import { displayTokenSymbol } from "../../dist/constants/index.js"

const CASES = [
  ["OXDAI", "DAI"],
  ["oxDAI", "DAI"],
  ["OXSUSDS", "SUSDS"],
  ["DAI", "DAI"],
  ["sUSDS", "sUSDS"],
  ["USDC", "USDC"],
]

for (const [stored, shown] of CASES) {
  test(`${stored} shows as ${shown}`, () => {
    assert.equal(displayTokenSymbol(stored), shown)
  })
}
