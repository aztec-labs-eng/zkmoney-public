/**
 * Request-row actions shared by the contact chat and the activity feed, wired to the web
 * singletons. Decline signals the requester over
 * XMTP, remind re-announces the stored row, cancel is a local status flip.
 */
import { getActiveNetworkId, RequestStorage, resolveAssetConstants } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import { getRequestBroadcaster } from "../../platform/xmtp/xmtpLifecycle"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { verifyTag } from "./registryResolution"
import {
  announceOutgoingRequest,
  declineIncomingRequest,
  markRequestPaidLocally,
} from "./requestFlow"

export async function resolveXmtpAddress(tag: string): Promise<string | null> {
  return (await verifyTag(tag))?.xmtpAddress ?? null
}

export async function declineRequestById(id: string): Promise<boolean> {
  const row = await RequestStorage.get().findById(id)
  const declined = await declineIncomingRequest(id, {
    store: RequestStorage.get(),
    broadcaster: getRequestBroadcaster(),
    resolveXmtpAddress,
    // The rollup address published at boot — the wire value peers compare on receive.
    networkId: getActiveNetworkId()!,
  })
  if (declined) {
    fireEvent("request_declined", {
      source: "contact",
      amount_bucket: requestAmountBucket(row?.amount ?? 0),
    })
  }
  return declined
}

export async function cancelRequestById(id: string): Promise<boolean> {
  const { applied } = await RequestStorage.get().applyStatus(id, "cancelled")
  return applied
}

/** Payer side after a fulfilling send lands: flip the local row (no-op for a link with no row). */
export async function markRequestPaidById(id: string, txHash: string): Promise<boolean> {
  return markRequestPaidLocally(id, txHash, RequestStorage.get())
}

/** Re-announce a stored outgoing request over XMTP. `tokenAddress` comes from the asset context. */
export async function remindRequestById(id: string, tokenAddress?: string): Promise<boolean> {
  // Demo mounts no XMTP; the reminder is acknowledged without a delivery.
  if (import.meta.env.DEV && isDemoMode()) return true
  const target = await RequestStorage.get().findById(id)
  const broadcaster = getRequestBroadcaster()
  const requesterTag = loadWalletIdentity()?.handle
  if (!target || !broadcaster || !requesterTag || !tokenAddress) return false
  const config = getConfig()
  const walletAsset = resolveAssetConstants(config.network).DAI
  await announceOutgoingRequest(target, {
    broadcaster,
    resolveXmtpAddress,
    requesterTag,
    networkId: getActiveNetworkId()!,
    token: { address: tokenAddress, symbol: walletAsset.symbol, decimals: walletAsset.decimals },
  })
  return true
}
