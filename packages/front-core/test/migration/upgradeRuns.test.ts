import { describe, expect, it } from "vitest"
import type { SIPADepositPhase } from "@obsidion/core/types"
import type { ActivityItem } from "../../src/core/services/bridge/BridgeActivityFeed"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import type { UpgradeBatchItem } from "../../src/core/migration/upgradeActivity"
import {
  upgradeBatchStatus,
  upgradeLegStatus,
  upgradeRecipients,
  upgradeRunsOf,
  upgradeRunStatus,
  upgradeRunValue,
  type UpgradeLeg,
} from "../../src/core/migration/upgradeRuns"

const DAI = 10n ** 18n

const batch = (
  id: string,
  state: UpgradeBatchItem["state"],
  over: Partial<UpgradeBatchItem> = {},
): ActivityItem => ({
  kind: "upgrade.batch",
  batch: {
    run: "run",
    id,
    recipient: `0x${id}`,
    amount: (10n * DAI).toString(),
    state,
    approved: state !== "planned",
    startTime: 1_000,
    ...over,
  },
})

const deposit = (sipa: string, phase: SIPADepositPhase, over: Partial<SIPADepositRecord> = {}) =>
  ({
    kind: "bridge.sipaDeposit",
    record: {
      sipaAddress: sipa,
      phase,
      amount: "9.9",
      netAmount: ((99n * DAI) / 10n).toString(),
      tokenSymbol: "DAI",
      startTime: 1_100,
      ...(phase === "claimed" ? { endTime: 1_200 } : {}),
      ...over,
    } as SIPADepositRecord,
  } as ActivityItem)

describe("upgrade runs", () => {
  it("joins each batch to its deposit by recipient, in plan order, once a batch is sent", () => {
    const [run, ...rest] = upgradeRunsOf([
      batch("remaining-2", "sent"),
      batch("remaining-0", "received"),
      deposit("0xREMAINING-0", "claimed"),
      {
        ...batch("remaining-1", "planned"),
        batch: {
          ...(batch("remaining-1", "planned") as { batch: UpgradeBatchItem }).batch,
          run: "other",
        },
      },
    ])
    expect(rest).toEqual([])
    expect(run!.legs.map((leg) => [leg.batch.id, leg.arrival?.phase])).toEqual([
      ["remaining-0", "claimed"],
      ["remaining-2", undefined],
    ])
    expect(run).toMatchObject({
      arrived: 1,
      complete: false,
      settled: false,
      total: 199n * (DAI / 10n),
    })
    expect([...upgradeRecipients([batch("remaining-0", "sent")])]).toEqual(["0xremaining-0"])
  })

  it("counts a batch at its amount until its deposit is swept", () => {
    const [run] = upgradeRunsOf([
      batch("remaining-0", "sent"),
      batch("remaining-1", "refunded"),
      deposit("0xremaining-1", "pendingClaim", { netAmount: ((96n * DAI) / 10n).toString() }),
    ])
    // The $10 the batch refunds, and the swept deposit's $9.60.
    expect(run!.total).toBe(100n * (DAI / 10n) + 96n * (DAI / 10n))
  })

  it("names a batch's step until its deposit is seen and funded", () => {
    expect(upgradeBatchStatus({ state: "planned", approved: false })).toBe("Waiting for approval")
    expect(upgradeBatchStatus({ state: "planned", approved: true })).toBe("Approved")
    expect(upgradeBatchStatus({ state: "sent", approved: true })).toBe("Releasing")
    expect(upgradeBatchStatus({ state: "refunded", approved: true })).toBe("Releasing")
    // Received on the destination is not credited yet: the deposit still has to be claimed.
    expect(upgradeBatchStatus({ state: "received", approved: true })).toBe("Receiving")
  })

  it("speaks for a leg in its deposit's words once that is funded, for every batch state", () => {
    const leg = (state: UpgradeBatchItem["state"], arrival?: ActivityItem): UpgradeLeg => ({
      batch: (batch("remaining-1", state) as { batch: UpgradeBatchItem }).batch,
      arrival: (arrival as { record: SIPADepositRecord } | undefined)?.record,
    })
    const unfunded = deposit("0xremaining-1", "resolved", { amount: "0" })
    const phases: [SIPADepositPhase, string][] = [
      ["funded", "Receiving"],
      ["broadcast", "Receiving"],
      ["sweeping", "Receiving"],
      ["pendingClaim", "Crediting"],
      ["claimed", "Completed"],
      ["recoverable", "Needs recovery"],
      ["recovered", "Recovered"],
      ["failed", "Deposit failed"],
    ]
    for (const state of ["planned", "sent", "refunded", "received"] as const) {
      const own = upgradeBatchStatus(leg(state).batch)
      expect(upgradeLegStatus(leg(state))).toBe(own)
      expect(upgradeLegStatus(leg(state, unfunded))).toBe(own)
      for (const [phase, status] of phases) {
        expect(
          upgradeLegStatus(leg(state, deposit("0xremaining-1", phase))),
          `${state}/${phase}`,
        ).toBe(status)
      }
    }
  })

  it("shows the run's least advanced step, a stop first, and nothing once it settled", () => {
    const runOf = (...items: ActivityItem[]) => upgradeRunsOf(items)[0]!
    expect(upgradeRunStatus(runOf(batch("remaining-0", "received")))).toBe("Receiving")
    expect(
      upgradeRunStatus(
        runOf(
          batch("remaining-0", "received"),
          deposit("0xremaining-0", "pendingClaim"),
          batch("remaining-1", "sent"),
          batch("remaining-2", "planned", { approved: false }),
        ),
      ),
    ).toBe("Waiting for approval")
    expect(
      upgradeRunStatus(
        runOf(
          batch("remaining-0", "received"),
          deposit("0xremaining-0", "claimed"),
          batch("remaining-1", "sent"),
        ),
      ),
    ).toBe("Releasing")
    expect(
      upgradeRunStatus(
        runOf(
          batch("remaining-0", "received"),
          deposit("0xremaining-0", "recoverable"),
          batch("remaining-1", "sent"),
        ),
      ),
    ).toBe("Needs recovery")
    expect(
      upgradeRunStatus(
        runOf(batch("remaining-0", "received"), deposit("0xremaining-0", "claimed")),
      ),
    ).toBeUndefined()
  })
})

describe("upgrade dollar values", () => {
  const mainToken = "0xDai"
  const savingsToken = "0xSavings"
  const pricing = { mainToken, savingsToken, sharePrice: (125n * DAI) / 100n }
  const run = (tokenAddress: string, extra: Partial<SIPADepositRecord> = {}) =>
    upgradeRunsOf([
      batch("remaining-0", "received"),
      deposit("0xremaining-0", "claimed", {
        tokenAddress: tokenAddress as `0x${string}`,
        netAmount: String(40n * DAI),
        ...extra,
      }),
    ])[0]!

  it("prices credited sUSDS shares with the existing vault price", () => {
    expect(upgradeRunValue(run(savingsToken), pricing)).toBe(50n * DAI)
  })

  it("keeps a DAI credit in dollars, including a converted sUSDS refund", () => {
    expect(upgradeRunValue(run(mainToken.toUpperCase()), pricing)).toBe(40n * DAI)
    expect(
      upgradeRunValue(run(savingsToken, { rowToken: mainToken as `0x${string}` }), pricing),
    ).toBe(40n * DAI)
  })

  it("shows no dollar value before the credited denomination or Savings price is known", () => {
    expect(upgradeRunValue(run(savingsToken), { mainToken, savingsToken })).toBeUndefined()
    expect(upgradeRunValue(run("0xUnknown"), pricing)).toBeUndefined()
    expect(upgradeRunValue(run(mainToken, { netAmount: undefined }), pricing)).toBeUndefined()
    expect(
      upgradeRunValue(upgradeRunsOf([batch("remaining-0", "sent")])[0]!, pricing),
    ).toBeUndefined()
  })

  it("values a batch at its amount in its run's token until its deposit is swept", () => {
    const pending = upgradeRunsOf([
      batch("remaining-0", "planned"),
      batch("remaining-1", "sent"),
      deposit("0xremaining-1", "broadcast", {
        tokenAddress: "0xDai",
        amount: "0",
        netAmount: undefined,
      }),
    ])[0]!
    expect(upgradeRunValue(pending, { ...pricing, runToken: () => mainToken })).toBe(20n * DAI)
    expect(upgradeRunValue(pending, { ...pricing, runToken: () => savingsToken })).toBe(25n * DAI)
    expect(upgradeRunValue(run(mainToken), { ...pricing, runToken: () => savingsToken })).toBe(
      40n * DAI,
    )
  })

  it("values each leg before adding them and excludes a recovered deposit", () => {
    const mixed = upgradeRunsOf([
      batch("remaining-0", "received"),
      batch("remaining-1", "received"),
      deposit("0xremaining-0", "claimed", {
        tokenAddress: mainToken as `0x${string}`,
        netAmount: String(10n * DAI),
      }),
      deposit("0xremaining-1", "claimed", {
        tokenAddress: savingsToken as `0x${string}`,
        netAmount: String(40n * DAI),
      }),
    ])[0]!
    expect(upgradeRunValue(mixed, pricing)).toBe(60n * DAI)
    expect(upgradeRunValue(run(savingsToken, { phase: "recovered" }), pricing)).toBe(0n)
  })
})
