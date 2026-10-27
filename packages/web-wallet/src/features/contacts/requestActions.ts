/**
 * Request-row actions shared by the contact chat and the activity feed, over the session's
 * requests. Decline signals the requester over
 * XMTP, remind re-announces the stored row, cancel is a local status flip.
 */
import { getActiveNetworkId, resolveAssetConstants } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import { session } from "../../platform/session"
import { getRequestBroadcaster } from "../../platform/xmtp/xmtpLifecycle"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { verifyTag } from "./registryResolution"
import { announceOutgoingRequest, declineIncomingRequest } from "./requestFlow"

export async function resolveXmtpAddress(tag: string): Promise<string | null> {
  return (await verifyTag(tag))?.xmtpAddress ?? null
}

export async function declineRequestById(id: string): Promise<boolean> {
  const { requests } = session()
  const row = requests.view.get().find((r) => r.id === id)
  const declined = await declineIncomingRequest(id, {
    store: requests,
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
  const { applied } = await session().requests.cancel(id)
  return applied
}

/**
 * Re-announce a stored outgoing request over XMTP, recording the reminder once it is delivered.
 * `tokenAddress` comes from the asset context.
 */
export async function remindRequestById(id: string, tokenAddress?: string): Promise<boolean> {
  const store = session().requests
  // Demo mounts no XMTP; the reminder is acknowledged without a delivery.
  if (import.meta.env.DEV && isDemoMode()) {
    await store.markReminded(id, Date.now())
    return true
  }
  const target = store.latest(id)
  const broadcaster = getRequestBroadcaster()
  const requesterTag = loadWalletIdentity()?.handle
  if (!target || !broadcaster || !requesterTag || !tokenAddress) return false
  const config = getConfig()
  const walletAsset = resolveAssetConstants(config.network).DAI
  const delivered = await announceOutgoingRequest(target, {
    broadcaster,
    resolveXmtpAddress,
    requesterTag,
    networkId: getActiveNetworkId()!,
    token: { address: tokenAddress, symbol: walletAsset.symbol, decimals: walletAsset.decimals },
  })
  if (delivered) await store.markReminded(id, Date.now())
  return delivered
}
