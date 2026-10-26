import { describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import type { ActivityItem } from "../../src/core/services/bridge/BridgeActivityFeed"
import { chainUpgradeBatches, chainUpgradeRun } from "../../src/core/migration/chainUpgradeBatches"
import { upgradeRunsOf } from "../../src/core/migration/upgradeRuns"

const DAI = 10n ** 18n
const MAIN = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const SAVINGS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"
const MAIN_PORTAL = "0x1111111111111111111111111111111111111111" as Address
const SAVINGS_PORTAL = "0x2222222222222222222222222222222222222222" as Address
const RUN = chainUpgradeRun(MAIN_PORTAL)
const direct = { recipientCommitment: ("0x" + "ab".repeat(32)) as Hex, portal: MAIN_PORTAL }

const record = (key: string, over: Partial<SIPADepositRecord> = {}) =>
  ({
    sipaAddress: key,
    phase: "claimed",
    amount: "9.9",
    netAmount: ((99n * DAI) / 10n).toString(),
    fee: "0",
    tokenSymbol: "DAI",
    tokenAddress: MAIN,
    tokenDecimals: 18,
    direct,
    inboxIndex: "1",
    startTime: 1_000,
    endTime: 1_100,
    ...over,
  } as SIPADepositRecord)

describe("chain upgrade batches", () => {
  it("lists each direct deposit as a batch of one run, oldest first", () => {
    const batches = chainUpgradeBatches(
      [
        record("0xB", { startTime: 3_000 }),
        record("0xA", { startTime: 2_000 }),
        record("0xSIPA", { direct: undefined }),
      ],
      new Set(),
    )

    expect(batches.map((b) => [b.run, b.id, b.recipient, b.state, b.inferred])).toEqual([
      [RUN, "remaining-0", "0xA", "received", true],
      [RUN, "remaining-1", "0xB", "received", true],
    ])
    expect(batches[0]).toMatchObject({
      amount: ((99n * DAI) / 10n).toString(),
      approved: true,
      startTime: 2_000,
    })
  })

  it("holds an announced deposit not yet seen as sent, at the batch's amount once known", () => {
    const [announced, expected] = chainUpgradeBatches(
      [
        record("0xA", {
          phase: "broadcast",
          amount: "0",
          netAmount: undefined,
          inboxIndex: undefined,
        }),
        record("0xB", {
          startTime: 2_000,
          direct: { ...direct, expected: (5n * DAI).toString() },
        }),
      ],
      new Set(),
    )

    expect(announced).toMatchObject({ state: "sent", amount: "0" })
    expect(expected).toMatchObject({ state: "received", amount: (5n * DAI).toString() })
  })

  it("keeps the deposits into each destination portal an upgrade of their own", () => {
    const savings = { ...direct, portal: SAVINGS_PORTAL }
    const batches = chainUpgradeBatches(
      [
        record("0xMAIN0", { startTime: 1_000 }),
        record("0xSAVINGS0", { startTime: 1_500, direct: savings, tokenAddress: SAVINGS }),
        record("0xMAIN1", { startTime: 2_000 }),
        // The portal its deposit landed in outranks the one its announcement named.
        record("0xSAVINGS1", {
          startTime: 2_500,
          sweeps: [
            { inboxIndex: "1", sweepTxHash: "0x01", netAmount: "1", portal: SAVINGS_PORTAL },
          ],
        }),
      ],
      new Set(),
    )

    expect(batches.map((b) => [b.run, b.id, b.recipient])).toEqual([
      [RUN, "remaining-0", "0xMAIN0"],
      [chainUpgradeRun(SAVINGS_PORTAL), "remaining-0", "0xSAVINGS0"],
      [RUN, "remaining-1", "0xMAIN1"],
      [chainUpgradeRun(SAVINGS_PORTAL), "remaining-1", "0xSAVINGS1"],
    ])
    // A saved run's key names its destination portal second; so does an inferred one's.
    expect(RUN.split("/")[1]).toBe(MAIN_PORTAL.toLowerCase())
    const runs = upgradeRunsOf(
      batches.map((batch) => ({
        kind: "upgrade.batch" as const,
        batch: { ...batch, state: "sent" as const },
      })),
    )
    expect(runs.map((r) => [r.run, r.legs.length])).toEqual([
      [RUN, 2],
      [chainUpgradeRun(SAVINGS_PORTAL), 2],
    ])
  })

  it("groups a record that names no portal by its asset", () => {
    const [batch] = chainUpgradeBatches(
      [
        record("0xA", {
          direct: { recipientCommitment: direct.recipientCommitment },
          rowToken: SAVINGS,
        }),
      ],
      new Set(),
    )
    expect(batch!.run).toBe(chainUpgradeRun(SAVINGS))
  })

  it("leaves a deposit one of this device's own runs pays to that run", () => {
    expect(chainUpgradeBatches([record("0xA")], new Set(["0xa"]))).toEqual([])
  })

  it("groups the deposits into one complete run that credits what they landed", () => {
    const records = [record("0xA"), record("0xB")]
    const items: ActivityItem[] = [
      ...records.map((r) => ({ kind: "bridge.sipaDeposit" as const, record: r })),
      ...chainUpgradeBatches(records, new Set()).map((batch) => ({
        kind: "upgrade.batch" as const,
        batch,
      })),
    ]

    const [run, ...rest] = upgradeRunsOf(items)

    expect(rest).toEqual([])
    expect(run).toMatchObject({
      run: RUN,
      arrived: 2,
      complete: true,
      settled: true,
      inferred: true,
    })
    expect(run!.total).toBe((2n * 99n * DAI) / 10n)
  })
})
