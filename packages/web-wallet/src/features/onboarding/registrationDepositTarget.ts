import { useMemo } from "react"
import type { Address } from "viem"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import type { DepositTarget, ShownAddress } from "../deposit/depositTarget"
import type { RegistrationAsk } from "./RegistrationAskLine"
import { reportRegistrationDepositShown } from "./registrationFunnel"
import { registrationAddressPublished } from "./webRegistration"

/**
 * The open registration's address as the deposit screen's target: its sweep takes the
 * registration's fee and needs its floor, and what is seen there feeds the registration.
 */
export function useRegistrationDepositTarget(
  record: PendingRegistrationRecord | null,
  name: string | undefined,
  ask: RegistrationAsk | null,
): DepositTarget | undefined {
  const sipa = record?.sipaAddress as Address | undefined
  const publishing = !!record && !registrationAddressPublished(record)
  // Stable while it names the same address: the screen watches it.
  const address = useMemo<ShownAddress | undefined>(
    () => (sipa && name ? { address: sipa, name, publishing } : undefined),
    [sipa, name, publishing],
  )
  const { total, floor, spent, seen } = ask ?? {}
  return useMemo(
    () =>
      address && {
        kind: "registration",
        address,
        fee: spent,
        floor,
        ask: total,
        held: seen,
        // The deposit rail's own cadence picks this up from here; nothing to push by hand.
        onFunded: () => {},
        onShown: reportRegistrationDepositShown,
      },
    [address, spent, floor, total, seen],
  )
}
