import {
  isSettledSipaPhase,
  upgradeBatchArrived,
  upgradeRunTotal,
  type ActivityItem,
  type SIPADepositRecord,
  type UpgradeBatchItem,
} from "@obsidion/front-core"

/** One batch of an upgrade, with the deposit that brings it once one is seen. */
export interface UpgradeLeg {
  batch: UpgradeBatchItem
  arrival?: SIPADepositRecord
}

/** One upgrade run, shown as a single activity row over its batches. */
export interface UpgradeRun {
  run: string
  legs: UpgradeLeg[]
  /** Legs whose deposit is credited. */
  arrived: number
  /** Every leg's deposit is credited. */
  complete: boolean
  /** Nothing more arrives: every leg's deposit has settled, credited or not. */
  settled: boolean
  /** What reaches the balance (`upgradeRunTotal`). */
  total: bigint
  time: number
}

/** The first batch first, then the others in the order they were planned (`remaining-N`). */
const legOrder = (leg: UpgradeLeg) =>
  leg.batch.first ? -1 : Number(/(\d+)$/.exec(leg.batch.id)?.[1] ?? 0)

export const legArrived = (leg: UpgradeLeg) => upgradeBatchArrived(leg.arrival)

/** The feed's upgrade batches by run, each with its deposit; a run shows once a batch is sent. */
export function upgradeRunsOf(items: readonly ActivityItem[]): UpgradeRun[] {
  const deposits = new Map(
    items.flatMap((item) =>
      item.kind === "bridge.sipaDeposit"
        ? [[item.record.sipaAddress.toLowerCase(), item.record] as const]
        : [],
    ),
  )
  const runs = new Map<string, UpgradeLeg[]>()
  for (const item of items) {
    if (item.kind !== "upgrade.batch") continue
    const legs = runs.get(item.batch.run) ?? []
    legs.push({ batch: item.batch, arrival: deposits.get(item.batch.recipient.toLowerCase()) })
    runs.set(item.batch.run, legs)
  }
  return [...runs.entries()]
    .filter(([, legs]) => legs.some((leg) => leg.batch.state !== "planned"))
    .map(([run, legs]) => {
      legs.sort((a, b) => legOrder(a) - legOrder(b))
      const arrived = legs.filter(legArrived).length
      return {
        run,
        legs,
        arrived,
        complete: arrived === legs.length,
        settled: legs.every((leg) => !!leg.arrival && isSettledSipaPhase(leg.arrival.phase)),
        total: upgradeRunTotal(legs),
        time: Math.max(
          ...legs.map((leg) => Math.max(leg.batch.startTime, leg.arrival?.endTime ?? 0)),
        ),
      }
    })
}

/** Every SIPA an upgrade batch pays: its deposit is one of the run's legs, not a row of its own. */
export function upgradeRecipients(items: readonly ActivityItem[]): ReadonlySet<string> {
  return new Set(
    items.flatMap((item) =>
      item.kind === "upgrade.batch" ? [item.batch.recipient.toLowerCase()] : [],
    ),
  )
}
