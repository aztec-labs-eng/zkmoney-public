import { describe, expect, it } from "vitest"
import type { FeedItem, HoldingPrice, MoveDeposit, MoveRecord } from "@obsidion/front-core"
import { oldVersionLeftovers } from "../../../../src/features/migration/oldVersionLeftovers"
import { moveRecord } from "../../../support/moves"

const ONE = 10n ** 18n

const move = (id: string, cents: bigint, extra: Partial<MoveRecord> = {}) =>
  moveRecord({ id, amount: (cents * ONE) / 100n, ...extra })
const deposit = (inboxIndex: bigint): MoveDeposit => ({ inboxIndex, amount: 1n, at: 1 })

const link = (
  networkId: string,
  amount: number,
  paylinkStatus = "awaitingClaim",
  status = "success",
) =>
  ({
    kind: "link",
    paylinkStatus,
    funding: status === "success" ? "settled" : "failed",
    link: { networkId, token: { amount, price: 1 } },
  } as unknown as FeedItem)

describe("old-version leftovers", () => {
  it("counts an old version's unfinished Savings moves and unclaimed paylinks, not this version's", () => {
    expect(
      oldVersionLeftovers({
        moves: [
          move("old", 1022n, { phase: "migrated" }),
          move("ran", 300n, { phase: "migrated", deposit: deposit(1n) }),
          move("done", 400n, { phase: "claimed", deposit: deposit(2n) }),
          move("new", 500n),
        ],
        items: [
          link("0xold", 10),
          link("0xold", 2, "expired"),
          link("0xnew", 3),
          link("0xold", 4, "claimed"),
          link("0xold", 5, "awaitingClaim", "failed"),
        ],
        price: () => undefined,
        network: "0xNEW",
      }),
    ).toEqual({
      savings: (1322n * ONE) / 100n,
      deposited: { main: false, savings: true },
      links: 12n * ONE,
      linkCount: 2,
    })
  })

  it("values each stranded move's shares at its own holding's price", () => {
    // Shares on their way out, with no quote kept: only the holding's price values them.
    const out = (id: string, holdingId: string) =>
      move(id, 1000n, { phase: "migrated", direction: "out", holdingId, quote: undefined })
    const priced = (sharePrice: bigint) =>
      ({ sharePrice, shareDecimals: 18, assetDecimals: 18 } as HoldingPrice)
    const prices: Record<string, HoldingPrice> = {
      "fea-a": priced(2n * ONE),
      "fea-b": priced(3n * ONE),
    }
    const left = (moves: MoveRecord[]) =>
      oldVersionLeftovers({
        moves,
        items: [],
        price: (holdingId) => prices[holdingId],
        network: "0xNEW",
      }).savings
    expect(left([out("a", "fea-a")])).toBe(20n * ONE)
    expect(left([out("a", "fea-a"), out("b", "fea-b")])).toBe(50n * ONE)
    expect(left([out("c", "fea-unpriced")])).toBe(0n)
  })
})
