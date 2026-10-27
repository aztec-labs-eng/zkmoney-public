/**
 * Runs the broadcast ledger in the active tab once the PXE is up and the boot order allows: every
 * SIPA broadcast this wallet owes is proven, one at a time, until it lands, including those an
 * earlier page left unfinished.
 */
import { useEffect } from "react"
import { useAztecContext, useBootReady } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { usePxeBoot } from "../../ui/PxeBoot"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { startBroadcasts } from "./broadcasts"
import { registrationExecutor } from "./registrationExecutor"
import { rotationExecutor } from "./rotationBroadcastExecutor"

export function BroadcastsMount(): null {
  const { obsidionWallet } = useAztecContext()
  const booted = usePxeBoot().bootStatus === "ready"
  const ready = useBootReady("broadcasts")
  useEffect(() => {
    if (!booted || !ready || !obsidionWallet) return
    return startBroadcasts(obsidionWallet, {
      registration: registrationExecutor(obsidionWallet, getConfig()),
      rotation: rotationExecutor(obsidionWallet, getConfig()),
      slot: getSipaDepositGateway().slotExecutor(obsidionWallet),
    })
  }, [booted, ready, obsidionWallet])
  return null
}
