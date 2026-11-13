import { describe, expect, it } from "vitest"
import {
  isMoveSettled,
  savingsMoveLabel,
  type MoveDeposit,
  type MoveQuote,
  type MoveState,
} from "@obsidion/front-core"
import {
  recoveredTo,
  savingsMoveFigure,
  savingsMoveStatus,
  STRANDED_STATUS,
} from "../../../src/features/savings/SavingsMoveRow"
import { savingsEtaCopy } from "../../../src/features/savings/savingsMoveTiming"
import { moveRecord as move } from "../../support/moves"

const ONE = 10n ** 18n
const PRICE = (107n * ONE) / 100n
const quote = (expectedOut: bigint, conversionOut: bigint) =>
  ({ expectedOut, conversionOut } as MoveQuote)
const deposit = (amount: bigint): MoveDeposit => ({ inboxIndex: 1n, amount, at: 1 })
const PENDING: MoveState = { kind: "pending" }

describe("savingsMoveFigure", () => {
  it("credits Savings with what the move put in, fixed from its record, whatever the shares are worth", () => {
    const landed = move({
      amount: 25n * ONE,
      quote: quote(25n * ONE, (2335n * ONE) / 100n),
      phase: "claimed",
      deposit: deposit(23n * ONE),
    })
    expect(savingsMoveFigure(landed, "savings", PRICE)).toBe((2335n * ONE) / 100n)
    expect(savingsMoveFigure(landed, "savings")).toBe((2335n * ONE) / 100n)
    // Main gave up the move's DAI.
    expect(savingsMoveFigure(landed, "main", PRICE)).toBe(25n * ONE)
    // Without a quote, a replayed move's landed shares at the price.
    const { quote: _, ...replayed } = landed
    expect(savingsMoveFigure(replayed, "savings", PRICE)).toBe((2461n * ONE) / 100n)
    expect(savingsMoveFigure(replayed, "savings")).toBeUndefined()
  })

  it("prices a move out: the shares at the vault's price on Savings, the DAI that lands on Main", () => {
    const out = move({ direction: "out", amount: 10n * ONE, quote: undefined })
    expect(savingsMoveFigure(out, "savings", PRICE)).toBe((107n * ONE) / 10n)
    expect(savingsMoveFigure(out, "savings")).toBeUndefined()
    const quoted = move({ ...out, quote: quote((1070n * ONE) / 100n, 9n * ONE) })
    expect(savingsMoveFigure(quoted, "savings", PRICE)).toBe((107n * ONE) / 10n)
    expect(savingsMoveFigure(quoted, "main", PRICE)).toBe(9n * ONE)
    const landed = move({ ...quoted, phase: "depositSeen", deposit: deposit((95n * ONE) / 10n) })
    expect(savingsMoveFigure(landed, "main", PRICE)).toBe((95n * ONE) / 10n)
  })

  it("debits Savings for a move out with what the vault paid, once read, whatever the price is now", () => {
    const read = move({
      direction: "out",
      amount: 10n * ONE,
      quote: quote((1070n * ONE) / 100n, 10n * ONE),
      assets: (1060n * ONE) / 100n,
    })
    expect(savingsMoveFigure(read, "savings", PRICE)).toBe((1060n * ONE) / 100n)
    expect(savingsMoveFigure({ ...read, quote: undefined }, "savings", PRICE * 2n)).toBe(
      (1060n * ONE) / 100n,
    )
  })
})

describe("savingsEtaCopy", () => {
  it("counts a leg down, or names a typical duration, in the speed picker's words", () => {
    expect(savingsEtaCopy({ seconds: 12 * 60 + 20, remaining: true })).toBe("About 12 min left")
    expect(savingsEtaCopy({ seconds: 25 * 60, remaining: false })).toBe("Usually about 25 min")
    expect(savingsEtaCopy({ seconds: 90 * 60, remaining: true })).toBe("About 1 h 30 min left")
    expect(savingsEtaCopy({ seconds: 5, remaining: true })).toBe("About 1 min left")
  })
})

describe("savingsMoveStatus", () => {
  it("ends a move an old version's record left unfinished, as one that needs recovery", () => {
    const stranded = move({ phase: "migrated" })
    expect(savingsMoveStatus(stranded, { kind: "done" })).toBe(STRANDED_STATUS)
    expect(isMoveSettled(stranded)).toBe(true)
    // A move here, and an old move that finished, keep their states.
    expect(savingsMoveStatus(move(), PENDING)).toBe(savingsMoveLabel("in"))
    expect(savingsMoveStatus(move({ phase: "claimed" }), { kind: "done" })).toBeUndefined()
  })

  it("ends a move whose escrow's DAI was recovered, and says where it went", () => {
    const recovered = move({
      phase: "recovered",
      recoveredTo: "0x1234000000000000000000000000000000abcd",
    })
    expect(savingsMoveStatus(recovered, { kind: "recovered" })).toBe("Recovered")
    expect(isMoveSettled(recovered)).toBe(true)
    expect(recoveredTo(recovered)).toBe("Recovered to 0x12340…0abcd")
    expect(isMoveSettled(move())).toBe(false)
  })

  it("keeps one state from submit until the deposit is claimed, then nothing", () => {
    const states: MoveState[] = [
      { kind: "proving" },
      { kind: "submitting" },
      PENDING,
      { kind: "delayed", reason: "vaultFull", dropped: false },
    ]
    for (const state of states) {
      expect(savingsMoveStatus(move(), state)).toBe(savingsMoveLabel("in"))
      expect(savingsMoveStatus(move({ direction: "out" }), state)).toBe(savingsMoveLabel("out"))
    }
    expect(savingsMoveStatus(move({ phase: "claimed" }), { kind: "done" })).toBeUndefined()
  })

  it("reads a failed or dropped burn as failed", () => {
    expect(savingsMoveStatus(move({ phase: "failed" }), { kind: "failed" })).toBe("Failed")
    expect(savingsMoveStatus(move({ phase: "dropped" }), { kind: "dropped" })).toBe("Failed")
  })
})
