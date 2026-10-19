import { useEffect } from "react"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import { useRegistrationTagConfirmed } from "../onboarding/openRegistration"
import { claimPublishesAddress } from "../paylink/ticketContinuation"
import { registrationAddressPublished } from "../onboarding/webRegistration"
import { oweRegistrationBroadcast } from "./broadcasts"

/**
 * A surface that shows a registration's address owes its broadcast once the tag is confirmed: the
 * ledger publishes it from there. Nothing else starts one, except a ticket signup's claim on the tab
 * holding its link, which publishes the address itself. `confirmed`: the surface itself settles the
 * tag (a setup step).
 */
export function useOweRegistrationBroadcast(
  record: PendingRegistrationRecord | null | undefined,
  shown: boolean,
  opts: { confirmed?: boolean } = {},
): void {
  const tagConfirmed = useRegistrationTagConfirmed(record ?? null)
  const confirmed = opts.confirmed === true || tagConfirmed
  const owed =
    shown &&
    confirmed &&
    !!record &&
    !registrationAddressPublished(record) &&
    !claimPublishesAddress(record)
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
