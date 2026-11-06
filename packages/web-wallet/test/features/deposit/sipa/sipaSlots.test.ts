/** Which self-derived addresses a view may take, and which slot the next derivation uses. */
import { describe, expect, it } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { SipaDeposit } from "@obsidion/front-core"
import {
  inSipaPool,
  nextSipaSlot,
  sipaPoolDeployment,
} from "../../../../src/features/deposit/sipaAddresses"

const MAX_NONCE = 1_000_000
const nonceOf = (slot: number) => MAX_NONCE - 1 - slot
const USER = "0x0a"
const TUPLE = {
  rollupVersion: "7",
  portal: "0x00000000000000000000000000000000000000a0",
  forwardingTable: "0x00000000000000000000000000000000000000fb",
} as OxideEnvTuple

const record = (over: Partial<SipaDeposit> = {}): SipaDeposit =>
  ({
    sipaAddress: "0x00000000000000000000000000000000000000c1",
    recipientL2Address: USER,
    phase: "resolved",
    amount: "0",
    ...over,
  } as SipaDeposit)

describe("nextSipaSlot", () => {
  it("takes the slot past the highest one this account recorded today, or the chain floor", () => {
    const records = [
      record({ slot: { day: 5, nonce: nonceOf(2) } }),
      record({ slot: { day: 5, nonce: nonceOf(0) } }),
      record({ slot: { day: 4, nonce: nonceOf(9) } }),
      record({ recipientL2Address: "0x0b", slot: { day: 5, nonce: nonceOf(7) } }),
    ]
    expect(nextSipaSlot(records, USER, 5, 0)).toBe(3)
    expect(nextSipaSlot(records, USER, 5, 6)).toBe(6)
    expect(nextSipaSlot(records, USER, 6, 0)).toBe(0)
  })
})

describe("inSipaPool", () => {
  const pooled = (over: Partial<SipaDeposit> = {}) =>
    record({
      slot: { day: 10, nonce: 1, deployment: sipaPoolDeployment(TUPLE) },
      broadcast: {
        kind: "pool",
        source: { type: "slot" },
        state: "landed",
        createdAt: 1,
        failures: 0,
      },
      ...over,
    })

  it("holds an unshown pool broadcast of this account and deployment, newer than the oldest day", () => {
    expect(inSipaPool(pooled(), USER, TUPLE, 9)).toBe(true)
    expect(inSipaPool(pooled(), USER, TUPLE, 10)).toBe(false)
    expect(inSipaPool(pooled(), "0x0b", TUPLE, 9)).toBe(false)
    expect(
      inSipaPool(pooled({ slot: { day: 10, nonce: 1, deployment: "1:0x1" } }), USER, TUPLE, 9),
    ).toBe(false)
    const shown = pooled().broadcast!
    expect(
      inSipaPool(pooled({ broadcast: { ...shown, kind: "deposit", shownAt: 2 } }), USER, TUPLE, 9),
    ).toBe(false)
  })
})
