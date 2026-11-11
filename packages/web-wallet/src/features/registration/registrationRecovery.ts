/** The session's refund recovery over the browser's L1 reads, and the view's refund read. */
import {
  bestEffort,
  createRegistrationRecovery,
  useStore,
  type PendingRegistrationRecord,
  type RegistrationRecovery,
  type RegistrationRecoveryDeps,
} from "@obsidion/front-core"
import { l1PublicClient } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import { useSession } from "../../session/session"
import { loadDepositTokens, sipaFundingTokens, tokenMetadata } from "../sipa/loadDepositFacts"
import { admissionFloor, refundedEntry } from "./admission"
import { healRegistrationDeposits, type RegistrationSeedStores } from "./registrationDepositSeed"

export function registrationRecovery(
  own: RegistrationSeedStores &
    Pick<RegistrationRecoveryDeps, "registrations" | "sipaDeposits"> & { page: PageFacts },
): RegistrationRecovery {
  const { config } = own.page
  return createRegistrationRecovery({
    registrations: own.registrations,
    sipaDeposits: own.sipaDeposits,
    l1: () => l1PublicClient(config),
    fundingTokens: (fee) => sipaFundingTokens(own.page, fee, "registration"),
    // The listed decimals when the table reads, the token's own otherwise: a failed table read
    // must not leave a confirmed refund unsized.
    decimalsOf: async (token) => {
      const listed = await bestEffort("unknown", loadDepositTokens(own.page, "registration"))
      const row = listed?.options.find((t) => t.address.toLowerCase() === token.toLowerCase())
      return row?.decimals ?? (await tokenMetadata(own.page, token)).decimals
    },
    admissionFloor,
    entryFor: refundedEntry,
    heal: (networkId) => healRegistrationDeposits(own, own.page, networkId),
  })
}

/** Whether the record's refund settled; the `registrationRefunds` task reconciles it. */
export function useRegistrationRefunded(record: PendingRegistrationRecord | null): boolean {
  const { sipaDeposits, registrations, registrationRecovery: recovery } = useSession()
  useStore(sipaDeposits.view)
  useStore(registrations.view)
  return record !== null && recovery.refunded(record)
}
