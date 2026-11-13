import { describe, expect, it } from "vitest"
import type { FeedItem, MoveDeposit, MoveRecord } from "@obsidion/front-core"
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
        network: "0xNEW",
      }),
    ).toEqual({
      savings: (1322n * ONE) / 100n,
      deposited: { main: false, savings: true },
      links: 12n * ONE,
      linkCount: 2,
    })
  })
})
