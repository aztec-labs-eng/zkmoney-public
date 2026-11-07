import type { SipaDeposit } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import {
  admissionFloor,
  depositAdmitted,
  refundedEntry,
} from "../../../src/features/registration/admission"
import { pendingRecord, SIPA } from "../../support/registrationFixtures"

// A drawn tag: the registration is at the earned price.
const record = pendingRecord({ route: "random" })
const deposit = (over: Partial<SipaDeposit>) => ({ sipaAddress: SIPA, ...over } as SipaDeposit)
/** A claimed sweep of `usdc` six-decimal units onto the 18-decimal row the floor is priced on. */
const usdcSweep = (usdc: bigint) =>
  [
    { grossAmount: usdc.toString(), fundingTokenDecimals: 6, tokenDecimals: 18, netAmount: "0" },
  ] as never
const toUsdc = (rowUnits: bigint) => rowUnits / 10n ** 12n

describe("a registration's deposit admits", () => {
  it.each([
    // The sweep emptied the address before the registry read: what it took still admits.
    [
      "a USDC sweep that took the floor",
      (f: bigint) => deposit({ heldBalance: "0", sweeps: usdcSweep(toUsdc(f)) }),
      true,
    ],
    [
      "a USDC sweep short of the floor",
      (f: bigint) => deposit({ heldBalance: "0", sweeps: usdcSweep(toUsdc(f) - 1n) }),
      false,
    ],
    [
      "a sweep not yet claimed, its credit and fee in the row's units",
      (f: bigint) => deposit({ pendingSweeps: [{ amount: String(f - 1n), fee: "1" }] as never }),
      true,
    ],
  ])("%s: %s", (_, held, admitted) => {
    expect(depositAdmitted(record, held(admissionFloor(record)))).toBe(admitted)
  })

  it.each([
    ["a bought tag", { route: "paid" as const }, false],
    ["a record with no route or earned quote", { route: undefined }, false],
    [
      "an earned quote with no route",
      { route: undefined, terms: { deadline: 1, earnedExpected: true } },
      true,
    ],
  ])("on %s, by the record's own expectation", (_, over, admitted) => {
    const priced = { ...record, ...over }
    const held = deposit({ heldBalance: String(admissionFloor(priced)) })
    expect(depositAdmitted(priced, held)).toBe(admitted)
  })

  it("carries a refund's entry onto the record only when the refund met the floor", () => {
    const floor = admissionFloor(record)
    const txHash = `0x${"ab".repeat(32)}` as const
    expect(refundedEntry(record, { amount: floor - 1n, txHash })).toBeUndefined()
    expect(refundedEntry(record, { amount: floor, txHash })).toEqual({
      sipaAddress: SIPA,
      recoveryTxHash: txHash,
      amount: floor.toString(),
    })
  })
})
