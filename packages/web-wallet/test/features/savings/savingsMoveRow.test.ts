import { describe, expect, it } from "vitest"
import {
  isMoveSettled,
  type HoldingPrice,
  type MoveDeposit,
  type MoveQuote,
  type MoveState,
} from "@obsidion/front-core"
import {
  savingsMoveFigure,
  savingsMoveStatus,
  vaultSwapFigures,
} from "../../../src/features/savings/savingsMove"
import { savingsEtaCopy } from "../../../src/features/savings/savingsMoveTiming"
import { moveRecord as move } from "../../support/moves"

const ONE = 10n ** 18n
/** A vault of an 18-decimal asset whose share redeems for 1.07. */
const PRICE: HoldingPrice = {
  sharePrice: (107n * ONE) / 100n,
  shareDecimals: 18,
  shareSymbol: "sUSDS",
  assetDecimals: 18,
  assetSymbol: "USDS",
  readAt: 1,
}
const USDC = 10n ** 6n
/** A vault of a 6-decimal asset whose share redeems for 1.05. */
const USDC_VAULT: HoldingPrice = { ...PRICE, sharePrice: 1_050_000n, assetDecimals: 6 }
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
    const dearer = { ...PRICE, sharePrice: 2n * PRICE.sharePrice }
    expect(savingsMoveFigure(landed, "savings", dearer)).toBe((2335n * ONE) / 100n)
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
    const dearer = { ...PRICE, sharePrice: 2n * PRICE.sharePrice }
    expect(savingsMoveFigure({ ...read, quote: undefined }, "savings", dearer)).toBe(
      (1060n * ONE) / 100n,
    )
  })

  it("reads a vault's asset in its own decimals, in each direction and from each side", () => {
    // 25 DAI in: 24.9 USDC reach the vault for 23.7 shares.
    const into = move({
      amount: 25n * ONE,
      quote: quote((237n * ONE) / 10n, (249n * USDC) / 10n),
      phase: "claimed",
      deposit: deposit((237n * ONE) / 10n),
    })
    expect(savingsMoveFigure(into, "savings", USDC_VAULT)).toBe((249n * ONE) / 10n)
    expect(savingsMoveFigure({ ...into, assets: (248n * USDC) / 10n }, "savings", USDC_VAULT)).toBe(
      (248n * ONE) / 10n,
    )
    expect(savingsMoveFigure(into, "main", USDC_VAULT)).toBe(25n * ONE)
    // 10 shares out: the vault pays 10.5 USDC, and 10.4 DAI land on Main.
    const out = move({
      direction: "out",
      amount: 10n * ONE,
      quote: quote((105n * USDC) / 10n, (104n * ONE) / 10n),
    })
    expect(savingsMoveFigure(out, "savings", USDC_VAULT)).toBe((105n * ONE) / 10n)
    expect(savingsMoveFigure({ ...out, assets: (103n * USDC) / 10n }, "savings", USDC_VAULT)).toBe(
      (103n * ONE) / 10n,
    )
    expect(savingsMoveFigure(out, "main", USDC_VAULT)).toBe((104n * ONE) / 10n)
    expect(savingsMoveFigure({ ...out, quote: undefined }, "savings", USDC_VAULT)).toBe(
      (105n * ONE) / 10n,
    )
  })

  it("names no figure in the vault's asset until the vault is priced, and still the ones in DAI", () => {
    const into = move({ amount: 25n * ONE, quote: quote(23n * ONE, 24n * ONE) })
    expect(savingsMoveFigure(into, "savings")).toBeUndefined()
    expect(savingsMoveFigure(into, "main")).toBe(25n * ONE)
    const out = move({ direction: "out", amount: 10n * ONE, quote: quote(11n * ONE, 9n * ONE) })
    expect(savingsMoveFigure(out, "savings")).toBeUndefined()
    expect(savingsMoveFigure({ ...out, assets: 11n * ONE }, "savings")).toBeUndefined()
    expect(savingsMoveFigure(out, "main")).toBe(9n * ONE)
  })
})

describe("vaultSwapFigures", () => {
  it("values what left at the source's price, and what landed at the destination's", () => {
    // 100 shares at 1.07 USDS swap into a USDC vault at 1.05, quoted to take in 106 USDC.
    const vaultSwapped = move({
      direction: "out",
      intoHoldingId: "fea-b",
      amount: 100n * ONE,
      quote: { ...quote(0n, 106n * USDC), routed: 99n * ONE },
    })
    expect(vaultSwapFigures(vaultSwapped, PRICE, USDC_VAULT)).toEqual({
      left: 107n * ONE,
      fee: (106n * ONE) / 99n,
      net: 106n * ONE,
    })
    // The route ran: what the vault took in, then the shares it landed.
    const ran = { ...vaultSwapped, assets: 105n * USDC }
    expect(vaultSwapFigures(ran, PRICE, USDC_VAULT).landed).toBe(105n * ONE)
    const landed = { ...ran, deposit: deposit(100n * ONE) }
    expect(vaultSwapFigures(landed, PRICE, USDC_VAULT).landed).toBe(105n * ONE)
    expect(vaultSwapFigures(landed, undefined, USDC_VAULT)).not.toHaveProperty("left")
    expect(vaultSwapFigures(landed, PRICE)).toEqual({ left: 107n * ONE })
  })

  it("fixes a swap's fee at its quote, however the source's price grows", () => {
    const vaultSwapped = move({
      direction: "out",
      intoHoldingId: "fea-b",
      amount: 100n * ONE,
      quote: { ...quote(0n, 106n * USDC), routed: 99n * ONE },
    })
    const grown = { ...PRICE, sharePrice: 2n * ONE }
    expect(vaultSwapFigures(vaultSwapped, grown, USDC_VAULT)).toMatchObject({
      left: 200n * ONE,
      fee: (106n * ONE) / 99n,
      net: 106n * ONE,
    })
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
  const kind = (...args: Parameters<typeof savingsMoveStatus>) => savingsMoveStatus(...args)?.kind

  it("ends a move an old version's record left unfinished, as stranded", () => {
    const stranded = move({ phase: "migrated" })
    expect(kind(stranded, { kind: "done" })).toBe("stranded")
    expect(isMoveSettled(stranded)).toBe(true)
    // A move here, and an old move that finished, keep their states.
    expect(kind(move(), PENDING)).toBe("moving")
    expect(kind(move({ phase: "claimed" }), { kind: "done" })).toBeUndefined()
  })

  it("ends a move whose escrow's DAI was recovered", () => {
    const recovered = move({
      phase: "recovered",
      recoveredTo: "0x1234000000000000000000000000000000abcd",
    })
    expect(kind(recovered, { kind: "recovered" })).toBe("recovered")
    expect(isMoveSettled(recovered)).toBe(true)
    expect(isMoveSettled(move())).toBe(false)
  })

  it("keeps one state from submit until the deposit is claimed, then nothing", () => {
    const states: MoveState[] = [{ kind: "proving" }, { kind: "submitting" }, PENDING]
    for (const state of states) {
      expect(kind(move(), state)).toBe("moving")
      expect(kind(move({ direction: "out" }), state)).toBe("moving")
    }
    expect(kind(move({ phase: "claimed" }), { kind: "done" })).toBeUndefined()
  })

  it("reads a move the relayer dropped as delayed by it, in either direction", () => {
    const state: MoveState = { kind: "delayed", reason: "relayerDropped", dropped: true }
    const delayed = { kind: "delayed", reason: "relayerDropped" }
    expect(savingsMoveStatus(move(), state)).toEqual(delayed)
    expect(savingsMoveStatus(move({ direction: "out" }), state)).toEqual(delayed)
  })

  it("reads a failed or dropped burn as failed", () => {
    expect(kind(move({ phase: "failed" }), { kind: "failed" })).toBe("failed")
    expect(kind(move({ phase: "dropped" }), { kind: "dropped" })).toBe("failed")
  })
})
