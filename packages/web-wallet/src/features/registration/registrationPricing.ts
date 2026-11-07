/** The sweep fee and the deployment's schedule: one read per session, made once something asks. */
import { useEffect } from "react"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { OxideSipaIntent, readDepositFee } from "@obsidion/sdk"
import {
  deploymentSipaRoute,
  resource,
  useResource,
  useStore,
  type Resource,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient } from "../../config/oxideTuple"
import { useSession } from "../../session/session"
import { readRegistrationSchedule } from "./registrationTerms"

const BACKOFF = { baseMs: 2_000, maxMs: 30_000 }

export interface PricingReads {
  /** The relayer's cut on a registration sweep: what a free tag still costs. */
  sweepFee(): Promise<bigint>
  schedule(): Promise<RegistrationSchedule>
}

export const chainPricing = (config: () => WebWalletConfig): PricingReads => ({
  sweepFee: async () =>
    readDepositFee(
      l1PublicClient(config()),
      deploymentSipaRoute(await getOxideTuple(config()), OxideSipaIntent.Registration),
    ),
  schedule: () => readRegistrationSchedule(config()),
})

export interface RegistrationPricing {
  sweepFee: Resource<bigint>
  /** Null where the deployment takes no registration by deposit: it prices zero, or its fee is
   *  under the sweep fee, so no balance at the address would fund the sweep. */
  registrationSchedule: Resource<RegistrationSchedule | null>
}

export function registrationPricing(reads: PricingReads): RegistrationPricing {
  const sweepFee = resource("sweepFee", { from: [], lazy: true, backoff: BACKOFF }, () =>
    reads.sweepFee(),
  )
  const registrationSchedule = resource(
    "registrationSchedule",
    { from: [sweepFee], lazy: true, backoff: BACKOFF },
    async ([fee]) => {
      const read = await reads.schedule()
      return (read.min === 0n && read.fee === 0n) || read.fee < fee ? null : read
    },
  )
  return { sweepFee, registrationSchedule }
}

/** Reads a failed price again now, ahead of its backoff. */
export function retryPricing(pricing: RegistrationPricing): void {
  for (const r of [pricing.sweepFee, pricing.registrationSchedule])
    if (r.get().status === "failed") r.retry()
}

/**
 * The sweep fee while `enabled`, and the schedule too while `schedule`: undefined while unread.
 * `failed` says the fee's last read failed.
 */
export function useRegistrationPricing(enabled: boolean, schedule = false) {
  const pricing = useSession()
  const { sweepFee, registrationSchedule } = pricing
  useEffect(() => {
    if (!enabled) return
    sweepFee.demand()
    if (schedule) registrationSchedule.demand()
  }, [enabled, schedule, sweepFee, registrationSchedule])
  const fee = useResource(sweepFee)
  const amounts = useResource(registrationSchedule)
  const failed = useStore(sweepFee, (s) => s.status === "failed")
  return {
    sweepFee: enabled ? fee : undefined,
    schedule: enabled && schedule ? amounts : undefined,
    failed: enabled && failed,
    retry: () => retryPricing(pricing),
  }
}
