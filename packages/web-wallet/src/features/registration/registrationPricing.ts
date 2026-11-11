/** The sweep fee and the deployment's schedule: one read per session, made once something asks. */
import type { RegistrationSchedule } from "@obsidion/core/types"
import { OxideSipaIntent, readDepositFee } from "@obsidion/sdk"
import {
  deploymentSipaRoute,
  memoryStore,
  useStore,
  type QueryEntry,
  type QueryFactory,
  type QueryState,
} from "@obsidion/front-core"
import { l1PublicClient } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import { useSession } from "../../session/session"
import { readRegistrationSchedule } from "./registrationTerms"
import { reportShortAsk } from "./registrationAsk"

const BACKOFF = { baseMs: 2_000, maxMs: 30_000 }

export interface PricingReads {
  /** The relayer's cut on a registration sweep: what a free tag still costs. */
  sweepFee(): Promise<bigint>
  schedule(): Promise<RegistrationSchedule>
}

export const chainPricing = (page: () => PageFacts): PricingReads => ({
  sweepFee: async () =>
    readDepositFee(
      l1PublicClient(page().config),
      deploymentSipaRoute(await page().chain.oxideTuple.read(), OxideSipaIntent.Registration),
    ),
  schedule: () => readRegistrationSchedule(page()),
})

export interface RegistrationPricing {
  sweepFee: QueryEntry<bigint>
  /** Null where the deployment takes no registration by deposit: it prices zero, or its fee is
   *  under the sweep fee, so no balance at the address would fund the sweep. */
  registrationSchedule: QueryEntry<RegistrationSchedule | null>
}

export function registrationPricing(query: QueryFactory, reads: PricingReads): RegistrationPricing {
  const sweepFee = query<[], bigint>("sweepFee", { load: () => reads.sweepFee(), retry: BACKOFF })()
  const registrationSchedule = query<[], RegistrationSchedule | null>("registrationSchedule", {
    load: async (signal) => {
      const [read, fee] = await Promise.all([reads.schedule(), sweepFee.read(signal)])
      reportShortAsk(read)
      return (read.min === 0n && read.fee === 0n) || read.fee < fee ? null : read
    },
    retry: BACKOFF,
  })()
  return { sweepFee, registrationSchedule }
}

/** Reads a failed price again now, ahead of its backoff. */
export function retryPricing(pricing: RegistrationPricing): void {
  for (const r of [pricing.sweepFee, pricing.registrationSchedule])
    if (r.get().status === "failed") r.refresh()
}

const UNREAD = memoryStore<QueryState<never>>({ status: "pending" }).readonly
const valueIn = <T>(s: QueryState<T>) => (s.status === "ready" ? s.value : undefined)

/**
 * The sweep fee while `enabled`, and the schedule too while `schedule`: undefined while unread.
 * `failed` says the fee's last read failed.
 */
export function useRegistrationPricing(enabled: boolean, schedule = false) {
  const pricing = useSession()
  const { sweepFee, registrationSchedule } = pricing
  const fee = useStore(enabled ? sweepFee : UNREAD)
  const amounts = useStore(enabled && schedule ? registrationSchedule : UNREAD)
  return {
    sweepFee: valueIn(fee),
    schedule: valueIn(amounts),
    failed: fee.status === "failed",
    retry: () => retryPricing(pricing),
  }
}
