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
    first: id === "proof",
    recipient: `0x${id}`,
    amount: (10n * DAI).toString(),
    exitFee: (DAI / 10n).toString(),
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
  }) as ActivityItem

describe("upgrade runs", () => {
  it("joins each batch to its deposit by recipient, first batch first, once a batch is sent", () => {
    const [run, ...rest] = upgradeRunsOf([
      batch("remaining-1", "sent"),
      batch("proof", "received"),
      deposit("0xPROOF", "claimed"),
      {
        ...batch("remaining-0", "planned"),
        batch: {
          ...(batch("remaining-0", "planned") as { batch: UpgradeBatchItem }).batch,
          run: "other",
        },
      },
    ])
    expect(rest).toEqual([])
    expect(run!.legs.map((leg) => [leg.batch.id, leg.arrival?.phase])).toEqual([
      ["proof", "claimed"],
      ["remaining-1", undefined],
    ])
    expect(run).toMatchObject({
      arrived: 1,
      complete: false,
      settled: false,
      total: 198n * (DAI / 10n),
    })
    expect([...upgradeRecipients([batch("proof", "sent")])]).toEqual(["0xproof"])
  })

  it("counts a batch at what it will land until its deposit is credited", () => {
    const [run] = upgradeRunsOf([
      batch("proof", "sent", { depositFee: (DAI / 2n).toString() }),
      batch("remaining-0", "refunded", { depositFee: (DAI / 4n).toString() }),
      deposit("0xremaining-0", "pendingClaim", { netAmount: ((96n * DAI) / 10n).toString() }),
    ])
    // $10 less the $0.10 tip and its $0.50 deposit fee, and the swept deposit's $9.60.
    expect(run!.total).toBe(94n * (DAI / 10n) + 96n * (DAI / 10n))
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
      batch: (batch("remaining-0", state) as { batch: UpgradeBatchItem }).batch,
      arrival: (arrival as { record: SIPADepositRecord } | undefined)?.record,
    })
    const unfunded = deposit("0xremaining-0", "resolved", { amount: "0" })
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
          upgradeLegStatus(leg(state, deposit("0xremaining-0", phase))),
          `${state}/${phase}`,
        ).toBe(status)
      }
    }
  })

  it("shows the run's least advanced step, a stop first, and nothing once it settled", () => {
    const runOf = (...items: ActivityItem[]) => upgradeRunsOf(items)[0]!
    expect(upgradeRunStatus(runOf(batch("proof", "received")))).toBe("Receiving")
    expect(
      upgradeRunStatus(
        runOf(
          batch("proof", "received"),
          deposit("0xproof", "pendingClaim"),
          batch("remaining-0", "sent"),
          batch("remaining-1", "planned", { approved: false }),
        ),
      ),
    ).toBe("Waiting for approval")
    expect(
      upgradeRunStatus(
        runOf(
          batch("proof", "received"),
          deposit("0xproof", "claimed"),
          batch("remaining-0", "sent"),
        ),
      ),
    ).toBe("Releasing")
    expect(
      upgradeRunStatus(
        runOf(
          batch("proof", "received"),
          deposit("0xproof", "recoverable"),
          batch("remaining-0", "sent"),
        ),
      ),
    ).toBe("Needs recovery")
    expect(
      upgradeRunStatus(runOf(batch("proof", "received"), deposit("0xproof", "claimed"))),
    ).toBeUndefined()
  })
})
