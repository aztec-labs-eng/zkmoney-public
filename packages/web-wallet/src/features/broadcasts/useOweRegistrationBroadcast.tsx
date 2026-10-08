import { useEffect } from "react"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import { registrationAddressPublished } from "../onboarding/webRegistration"
import { oweRegistrationBroadcast } from "./broadcasts"

/**
 * A surface that shows a registration's address, or claims a payment into it, owes its broadcast:
 * the ledger publishes it from there. Nothing else starts one.
 */
export function useOweRegistrationBroadcast(
  record: PendingRegistrationRecord | null | undefined,
  shown: boolean,
): void {
  const owed = shown && !!record && !registrationAddressPublished(record)
  const account = record?.account
  const sipaAddress = record?.sipaAddress
  useEffect(() => {
    if (!owed || !account || !sipaAddress) return
    oweRegistrationBroadcast({ account, sipaAddress }).catch((err: unknown) =>
      console.warn("[broadcasts] could not owe the registration's broadcast", err),
    )
  }, [owed, account, sipaAddress])
}

/** The hook for a sheet that decides what it shows after its early returns. */
export function OweRegistrationBroadcast({ record }: { record: PendingRegistrationRecord }) {
  useOweRegistrationBroadcast(record, true)
  return null
}
