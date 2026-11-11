// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  entryBlocks,
  type EntryConditions,
} from "../../../src/features/backupPasskey/backupPasskeyEntry"
import { ENTRY_READY } from "../../support/backupAdd"

const DAI = 10n ** 18n

const blocks = (over: Partial<EntryConditions>) => entryBlocks({ ...ENTRY_READY, ...over })
const open = (over: Partial<EntryConditions>) => blocks(over).filter((block) => !block.done)

describe("the add entry's conditions", () => {
  it("lists every condition, all done when nothing holds the add", () => {
    expect(blocks({}).map((block) => block.id)).toEqual([
      "firstPasskey",
      "registered",
      "route",
      "savings",
      "withdrawal",
      "link",
      "migration",
      "balance",
      "pieces",
      "synced",
      "uses",
    ])
    expect(open({})).toEqual([])
  })

  it("marks each unmet condition with what clears it and what its words need", () => {
    expect(open({ sessionIsRoot: false })).toMatchObject([{ id: "firstPasskey" }])
    expect(open({ verified: false })).toMatchObject([{ id: "registered", finishing: false }])
    expect(open({ registering: true })).toMatchObject([{ id: "registered", finishing: true }])
    expect(open({ routeLive: false })).toMatchObject([{ id: "route" }])
    expect(open({ savingsMoving: true })).toMatchObject([{ id: "savings", action: "savings" }])
    expect(open({ withdrawalInFlight: true })).toMatchObject([
      { id: "withdrawal", action: "activity" },
    ])
    for (const hold of [{ kind: "creating" }, { kind: "token" }, { kind: "cancel" }] as const)
      expect(open({ linkHold: hold })).toEqual([
        { id: "link", hold, done: false, action: "activity" },
      ])
    expect(open({ linkHold: { kind: "expiry", until: 2000 } })).toEqual([
      { id: "link", hold: { kind: "expiry", until: 2000 }, done: false },
    ])
    expect(open({ historicBalance: true })).toMatchObject([
      { id: "migration", action: "migration" },
    ])
    expect(open({ balance: DAI })).toEqual([
      { id: "balance", need: 2n * DAI, have: DAI, done: false, action: "deposit" },
    ])
    expect(open({ chunk: { kind: "short", chunk: 3n * DAI } })).toEqual([
      { id: "pieces", send: 3n * DAI, done: false },
    ])
    expect(open({ plan: false })).toMatchObject([{ id: "synced" }])
    expect(open({ usesLeft: false })).toMatchObject([{ id: "uses" }])
  })

  it("lists every unmet condition at once, in order", () => {
    const ids = open({ withdrawalInFlight: true, balance: DAI, usesLeft: false }).map((b) => b.id)
    expect(ids).toEqual(["withdrawal", "balance", "uses"])
  })

  it("counts a Savings move's burn as the move, not as a withdrawal", () => {
    expect(open({ savingsMoving: true, withdrawalInFlight: true })).toMatchObject([
      { id: "savings" },
    ])
  })

  it("names a balance short of the funding once, not as small pieces too", () => {
    const short = { kind: "short", chunk: DAI } as const
    expect(open({ balance: DAI, chunk: short }).map((b) => b.id)).toEqual(["balance"])
  })

  it("a balance exactly at the funding amount is enough", () => {
    expect(open({ balance: 2n * DAI })).toEqual([])
  })
})
