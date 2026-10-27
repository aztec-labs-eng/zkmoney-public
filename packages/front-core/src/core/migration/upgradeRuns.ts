import type { ActivityItem } from "../services/bridge/BridgeActivityFeed"
import { DEPOSIT_PHASE_COPY, depositPhaseCopy } from "../services/deposits/depositCopy"
import { isSettledSipaPhase, type SIPADepositRecord } from "../services/deposits/SIPADepositStore"
import { savingsValue } from "../services/savings/savingsMath"
import {
  upgradeBatchArrived,
  upgradeBatchFigure,
  upgradeRunTotal,
  type UpgradeBatchItem,
} from "./upgradeActivity"

/** One batch of an upgrade, with the deposit that brings it once one is seen. */
export interface UpgradeLeg {
  batch: UpgradeBatchItem
  arrival?: SIPADepositRecord
}

/** One upgrade run over its batches, as Activity's row and the bell's entry show it. */
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
  /** Read off chain: discovery may still add legs to it. */
  inferred: boolean
}

/** The batches in the order they were planned (`remaining-N`). */
const legOrder = (leg: UpgradeLeg) => Number(/(\d+)$/.exec(leg.batch.id)?.[1] ?? 0)

export const legArrived = (leg: UpgradeLeg) => upgradeBatchArrived(leg.arrival)

/** Nothing more arrives for a leg: its deposit settled, credited or not. */
export const legSettled = (leg: Pick<UpgradeLeg, "arrival">) =>
  !!leg.arrival && isSettledSipaPhase(leg.arrival.phase)

/** The feed's upgrade batches by run, each with its deposit; a run shows once a batch is sent. */
export function upgradeRunsOf(items: readonly ActivityItem[]): UpgradeRun[] {
  const deposits = new Map(
    items.flatMap((item) =>
      item.kind === "bridge.sipaDeposit" && !item.credit
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
        settled: legs.every(legSettled),
        total: upgradeRunTotal(legs),
        inferred: legs.every((leg) => leg.batch.inferred),
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

/** The deposit that speaks for a leg: seen, and funded or swept. */
export function legDeposit(leg: UpgradeLeg): SIPADepositRecord | undefined {
  const arrival = leg.arrival
  return arrival && (arrival.sweepTxHash || Number(arrival.amount) > 0) ? arrival : undefined
}

/** Where a batch stands until its deposit speaks for it. */
export function upgradeBatchStatus(batch: Pick<UpgradeBatchItem, "state" | "approved">): string {
  switch (batch.state) {
    case "planned":
      return batch.approved ? "Approved" : "Waiting for approval"
    case "sent":
    case "refunded":
      return "Releasing"
    // On the destination but not yet credited: its deposit still has to be claimed.
    case "received":
      return DEPOSIT_PHASE_COPY.funded.status
  }
}

/** Where a leg stands: its deposit's status once that speaks for it, its batch's until then. */
export function upgradeLegStatus(leg: UpgradeLeg): string {
  const deposit = legDeposit(leg)
  return deposit ? depositPhaseCopy(deposit).status : upgradeBatchStatus(leg.batch)
}

/** A leg's steps before it settles, earliest first. */
const STEPS = ["Waiting for approval", "Approved", "Releasing", "Receiving", "Crediting"]

/**
 * A run's row status: the least advanced step among legs still to settle, a stop such as Needs
 * recovery first. None once nothing more arrives.
 */
export function upgradeRunStatus(run: UpgradeRun): string | undefined {
  if (run.settled) return undefined
  const rank = (status: string) => STEPS.indexOf(status)
  return run.legs
    .filter((leg) => !legSettled(leg))
    .map(upgradeLegStatus)
    .sort((a, b) => rank(a) - rank(b))[0]
}

export interface UpgradePricing {
  mainToken?: string
  savingsToken?: string
  sharePrice?: bigint
  /** The token run `run` credits, which values a batch until its deposit is swept. */
  runToken?(run: string): string | undefined
}

/** Dollar value in the credited asset. An unknown credited token or Savings price stays unknown. */
export function upgradeLegValue(leg: UpgradeLeg, pricing: UpgradePricing): bigint | undefined {
  if (legSettled(leg) && !legArrived(leg)) return 0n
  const arrival = leg.arrival
  const token = (
    arrival?.netAmount == null
      ? pricing.runToken?.(leg.batch.run)
      : arrival.rowToken ?? arrival.tokenAddress
  )?.toLowerCase()
  if (!token) return undefined
  const amount = upgradeBatchFigure(leg.batch, arrival)
  if (token === pricing.mainToken?.toLowerCase()) return amount
  if (token === pricing.savingsToken?.toLowerCase() && pricing.sharePrice !== undefined)
    return savingsValue(amount, pricing.sharePrice)
  return undefined
}

export function upgradeRunValue(run: UpgradeRun, pricing: UpgradePricing): bigint | undefined {
  let total = 0n
  for (const leg of run.legs) {
    const value = upgradeLegValue(leg, pricing)
    if (value === undefined) return undefined
    total += value
  }
  return total
}
