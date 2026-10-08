/**
 * Runs the broadcast ledger in the active tab once the PXE is up: every SIPA broadcast this wallet
 * owes is proven, one at a time, until it lands, including those an earlier page left unfinished.
 */
import { useEffect } from "react"
import { useAztecContext } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { usePxeBoot } from "../../ui/PxeBoot"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { startBroadcasts } from "./broadcasts"
import { registrationExecutor } from "./registrationExecutor"

export function BroadcastsMount(): null {
  const { obsidionWallet } = useAztecContext()
  const ready = usePxeBoot().bootStatus === "ready"
  useEffect(() => {
    if (!ready || !obsidionWallet) return
    return startBroadcasts(obsidionWallet, {
      registration: registrationExecutor(obsidionWallet, getConfig()),
      slot: getSipaDepositGateway().slotExecutor(obsidionWallet),
    })
  }, [ready, obsidionWallet])
  return null
}
