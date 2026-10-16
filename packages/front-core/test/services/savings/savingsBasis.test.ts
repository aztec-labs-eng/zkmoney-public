import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import {
  savingsEarned,
  savingsEarningsPending,
  savingsLedger,
  savingsMoveBasis,
} from "../../../src/core/services/savings/savingsBasis"
import type { SavingsMoveRecord } from "../../../src/core/services/savings/types"

const ONE = 10n ** 18n
/** Shares at a 1.07 share price: what `usds` buys. */
const sharesFor = (usds: bigint) => (usds * 100n) / 107n

let n = 0
const move = (direction: "in" | "out", extra: Partial<SavingsMoveRecord>): SavingsMoveRecord =>
  ({
    direction,
    withdrawalLocalId: `w${++n}`,
    escrow: "0x00000000000000000000000000000000000000ee",
    nonce: "0x01",
    recipientCommitment: "0x02",
    amount: "0",
    startTime: n,
    ...extra,
  } as SavingsMoveRecord)
/** A move in made by the flow: its quote's net is what entered the vault. */
const landed = (usds: bigint) =>
  move("in", {
    amount: (usds + 3n * ONE).toString(),
    net: usds.toString(),
    deposit: { inboxIndex: "1", amount: sharesFor(usds).toString(), claimed: true },
  })
/** A move out made by the flow: `value` is what its shares were worth when they left. */
const left = (shares: bigint, phase: WithdrawalRecord["phase"] = "done", value?: bigint) => {
  const out = move("out", {
    amount: shares.toString(),
    ...(value === undefined ? {} : { value: value.toString() }),
  })
  return { out, burn: { localId: out.withdrawalLocalId, phase } as WithdrawalRecord }
}
const burns = (...records: WithdrawalRecord[]) => new Map(records.map((r) => [r.localId, r]))

describe("savingsMoveBasis", () => {
  it("is the quote's net, as on a move claimed before any landed price was kept", () => {
    expect(savingsMoveBasis({ net: (254_71n * ONE) / 100n + "" }, undefined)).toBe(
      (254_71n * ONE) / 100n,
    )
  })

  it("sums a rebuilt move's burn fields: what burned less the source cut and both tips", () => {
    const burn = {
      rawAmount: (260n * ONE).toString(),
      fpcFundingCut: (ONE / 4n).toString(),
      relayerTip: (ONE / 2n).toString(),
      skyMove: { relayerTip: (114n * ONE) / 100n + "" } as WithdrawalRecord["skyMove"],
    }
    expect(savingsMoveBasis({}, burn as never)).toBe(
      260n * ONE - ONE / 4n - ONE / 2n - (114n * ONE) / 100n,
    )
    expect(savingsMoveBasis({}, undefined)).toBeUndefined()
    expect(savingsMoveBasis({}, { ...burn, rawAmount: undefined } as never)).toBeUndefined()
    expect(savingsMoveBasis({}, { ...burn, skyMove: undefined } as never)).toBeUndefined()
  })
})

describe("savingsLedger", () => {
  it("in only: earnings are the value above what was put in", () => {
    const ledger = savingsLedger([landed(107n * ONE)], burns())
    expect(ledger).toMatchObject({ basis: 107n * ONE, counted: 1, excluded: [] })
    expect(ledger.shares).toBe(sharesFor(107n * ONE))
    const held = ledger.shares
    expect(savingsEarned(ledger, 110n * ONE, held)).toBe(3n * ONE)
    // A tiny gain still counts, and a position worth less than it cost reads below zero.
    expect(savingsEarned(ledger, 107n * ONE + 1n, held)).toBe(1n)
    expect(savingsEarned(ledger, 100n * ONE, held)).toBe(-7n * ONE)
  })

  it("a full move out leaves nothing to earn on: zero, whatever the moves earned before", () => {
    const first = landed(107n * ONE)
    const { out, burn } = left(sharesFor(107n * ONE), "done", 110n * ONE)
    const ledger = savingsLedger([first, out], burns(burn))
    expect(ledger).toMatchObject({ basis: 0n, shares: 0n, counted: 2, excluded: [] })
    expect(savingsEarned(ledger, 0n, 0n)).toBe(0n)
  })

  it("in, earn, then half out: what is left earns half the unrealized gain", () => {
    // 100 shares bought for 100, now worth 110: half leave, with half the cost.
    const first = move("in", {
      net: (100n * ONE).toString(),
      deposit: { inboxIndex: "1", amount: (100n * ONE).toString(), claimed: true },
    })
    const { out, burn } = left(50n * ONE, "done", 55n * ONE)
    const ledger = savingsLedger([first, out], burns(burn))
    expect(ledger).toMatchObject({ basis: 50n * ONE, shares: 50n * ONE })
    expect(savingsEarned(ledger, 55n * ONE, 50n * ONE)).toBe(5n * ONE)
    // A move out needs no figure of its own: it takes its part of the cost.
    const rebuilt = left(50n * ONE, "done")
    const again = savingsLedger([first, rebuilt.out], burns(rebuilt.burn))
    expect(again.excluded).toEqual([])
    expect(again.basis).toBe(50n * ONE)
  })

  it("replays shares in the order they moved: a move out mined before a top-up landed takes none of its cost", () => {
    // 100 shares for 100 landed first. A top-up of 50 shares for 60 starts next, but before it lands
    // a move out of 50 shares is mined: it takes half of the first cost, none of the top-up's.
    const first = move("in", {
      startTime: 0,
      net: (100n * ONE).toString(),
      deposit: { inboxIndex: "1", amount: (100n * ONE).toString(), claimed: true, at: 100 },
    })
    const topUp = move("in", {
      startTime: 1,
      net: (60n * ONE).toString(),
      deposit: { inboxIndex: "2", amount: (50n * ONE).toString(), claimed: true, at: 300 },
    })
    const out = move("out", { startTime: 2, amount: (50n * ONE).toString() })
    const burn = {
      localId: out.withdrawalLocalId,
      phase: "done",
      startTime: 2,
      minedAt: 200,
    } as WithdrawalRecord
    const ledger = savingsLedger([first, topUp, out], burns(burn))
    expect(ledger.basis).toBe(110n * ONE)
    expect(ledger.shares).toBe(100n * ONE)
  })

  it("replays in the order the moves were made, whatever order the store lists them", () => {
    const first = landed(100n * ONE)
    const { out, burn } = left(sharesFor(100n * ONE), "done")
    const second = landed(30n * ONE)
    const ledger = savingsLedger([second, out, first], burns(burn))
    expect(ledger.basis).toBe(30n * ONE)
    expect(ledger.shares).toBe(sharesFor(30n * ONE))
  })

  it("leaves a failed or unsent move out uncounted, and a pending move in too", () => {
    const first = landed(107n * ONE)
    const failed = left(40n * ONE, "failed", 50n * ONE)
    const proving = left(10n * ONE, "submitting", 10n * ONE)
    const pending = move("in", {
      net: (10n * ONE).toString(),
      deposit: { inboxIndex: "2", amount: (9n * ONE).toString(), claimed: false },
    })
    const ledger = savingsLedger(
      [first, failed.out, proving.out, pending],
      burns(failed.burn, proving.burn),
    )
    expect(ledger).toMatchObject({ basis: 107n * ONE, counted: 1, excluded: [] })
    expect(ledger.shares).toBe(sharesFor(107n * ONE))
  })

  it("holds a move out sent but not yet mined as pending, so the figure waits rather than reads a loss", () => {
    const first = landed(107n * ONE)
    const { out, burn } = left(40n * ONE, "submitting")
    const ledger = savingsLedger(
      [first, out],
      burns({ ...burn, l2TxHash: "0x5e" } as WithdrawalRecord),
    )
    expect(ledger.excluded).toEqual([
      {
        withdrawalLocalId: out.withdrawalLocalId,
        reason: "burn sent, not yet mined",
        backfilling: true,
      },
    ])
    expect(savingsEarned(ledger, 70n * ONE, sharesFor(107n * ONE) - 40n * ONE)).toBeUndefined()
    expect(savingsEarningsPending(ledger)).toBe(true)
  })

  it("shows the figure when the shares held differ from the replay by dust, and hides it beyond that", () => {
    const ledger = savingsLedger([landed(107n * ONE)], burns())
    expect(savingsEarned(ledger, 108n * ONE, ledger.shares + 3n)).toBe(1n * ONE)
    expect(savingsEarned(ledger, 108n * ONE, ledger.shares - 3n)).toBe(1n * ONE)
    // A restored device before its moves are rebuilt: the balance would read as earnings.
    expect(savingsEarned(savingsLedger([], burns()), 108n * ONE, ledger.shares)).toBeUndefined()
  })

  it("names a claimed move in whose figures cannot be derived; the total is unknown, never the value now", () => {
    const rebuilt = move("in", {
      amount: (260n * ONE).toString(),
      deposit: { inboxIndex: "1", amount: sharesFor(258n * ONE).toString(), claimed: true },
    })
    const ledger = savingsLedger([rebuilt], burns())
    expect(ledger.excluded).toEqual([
      {
        withdrawalLocalId: rebuilt.withdrawalLocalId,
        reason: "no net or burn figures",
        backfilling: true,
      },
    ])
    expect(savingsEarned(ledger, 752n * ONE, ledger.shares)).toBeUndefined()
    // Once its escrow run turned out to hold no vault event, the figure is gone for good, with the reason.
    const unknown = savingsLedger(
      [{ ...rebuilt, vaultUnknown: "no vault Deposit for its shares in 0xab", vaultLookup: 2 }],
      burns(),
    )
    expect(unknown.excluded).toEqual([
      {
        withdrawalLocalId: rebuilt.withdrawalLocalId,
        reason: "no vault Deposit for its shares in 0xab",
        backfilling: false,
      },
    ])
    expect(savingsEarningsPending(unknown)).toBe(false)
    expect(savingsEarned(unknown, 752n * ONE, unknown.shares)).toBeUndefined()
    expect(savingsLedger([], burns())).toEqual({ basis: 0n, counted: 0, shares: 0n, excluded: [] })
  })

  it("takes the vault's own figures from the escrow runs first: rebuilt in and out backfilled from receipts", () => {
    const TX = `0x${"ab".repeat(32)}` as const
    const rebuiltIn = move("in", {
      amount: (260n * ONE).toString(),
      deposit: {
        inboxIndex: "1",
        amount: sharesFor(254n * ONE).toString(),
        claimed: true,
        txHash: TX,
      },
      vault: {
        txHash: TX,
        assets: ((25471n * ONE) / 100n).toString(),
        shares: sharesFor(254n * ONE).toString(),
      },
    })
    const rebuiltOut = move("out", {
      amount: (100n * ONE).toString(),
      deposit: { inboxIndex: "2", amount: (106n * ONE).toString(), claimed: true, txHash: TX },
      vault: { txHash: TX, assets: (107n * ONE).toString(), shares: (100n * ONE).toString() },
    })
    // A flow-made move in whose quote said 50 but whose vault figure says 49.9: the vault wins.
    const quoted = move("in", {
      amount: (51n * ONE).toString(),
      net: (50n * ONE).toString(),
      deposit: { inboxIndex: "3", amount: (47n * ONE).toString(), claimed: true },
      vault: {
        txHash: TX,
        assets: ((499n * ONE) / 10n).toString(),
        shares: (47n * ONE).toString(),
      },
    })
    const ledger = savingsLedger([rebuiltIn, rebuiltOut, quoted], burns())
    expect(ledger.excluded).toEqual([])
    // The move out takes its part of the first move's cost; the second adds the vault's figure.
    const firstShares = sharesFor(254n * ONE)
    const firstCost = (25471n * ONE) / 100n
    const basis = firstCost - (firstCost * 100n * ONE) / firstShares + (499n * ONE) / 10n
    expect(ledger.basis).toBe(basis)
    expect(ledger.shares).toBe(firstShares - 100n * ONE + 47n * ONE)
    expect(savingsEarned(ledger, 200n * ONE, ledger.shares)).toBe(200n * ONE - basis)
    expect(savingsMoveBasis(quoted, undefined)).toBe((499n * ONE) / 10n)
  })
})
