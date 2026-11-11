/**
 * Request-row actions shared by the contact chat and the activity feed, over the session's
 * requests. Decline signals the requester over
 * XMTP, remind re-announces the stored row, cancel is a local status flip.
 */
import { resolveAssetConstants, valueOf } from "@obsidion/front-core"
import { isDemoMode } from "../../dev/demoFlag"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import type { Session } from "../../session/session"
import { getRequestBroadcaster } from "../../platform/xmtp/xmtpLifecycle"
import { verifyTag } from "./registryResolution"
import { announceOutgoingRequest, declineIncomingRequest } from "./requestFlow"

export async function resolveXmtpAddress(
  session: Pick<Session, "page">,
  tag: string,
): Promise<string | null> {
  return (await verifyTag(session.page, tag))?.xmtpAddress ?? null
}

type RequestSession = Pick<Session, "requests" | "wallet" | "network" | "page">

export async function declineRequestById(session: RequestSession, id: string): Promise<boolean> {
  const { requests, wallet } = session
  // The wire value peers compare on receive.
  const networkId = valueOf(wallet)?.networkId
  if (!networkId) return false
  const row = await requests.get(id)
  const declined = await declineIncomingRequest(id, {
    store: requests,
    broadcaster: getRequestBroadcaster(),
    resolveXmtpAddress: (tag) => resolveXmtpAddress(session, tag),
    networkId,
  })
  if (declined) {
    fireEvent("request_declined", {
      source: "contact",
      amount_bucket: requestAmountBucket(row?.amount ?? 0),
    })
  }
  return declined
}

export async function cancelRequestById(session: RequestSession, id: string): Promise<boolean> {
  const { applied } = await session.requests.cancel(id)
  return applied
}

/**
 * Re-announce a stored outgoing request over XMTP, recording the reminder once it is delivered.
 * `requesterTag` is the identity's, and `tokenAddress` comes from the session's token.
 */
export async function remindRequestById(
  session: RequestSession,
  id: string,
  requesterTag: string | undefined,
  tokenAddress?: string,
): Promise<boolean> {
  const store = session.requests
  // Demo mounts no XMTP; the reminder is acknowledged without a delivery.
  if (import.meta.env.DEV && isDemoMode()) {
    await store.markReminded(id, Date.now())
    return true
  }
  const target = await store.get(id)
  const broadcaster = getRequestBroadcaster()
  const networkId = valueOf(session.wallet)?.networkId
  if (!target || !broadcaster || !requesterTag || !tokenAddress || !networkId) return false
  const walletAsset = resolveAssetConstants(session.network).DAI
  const delivered = await announceOutgoingRequest(target, {
    broadcaster,
    resolveXmtpAddress: (tag) => resolveXmtpAddress(session, tag),
    requesterTag,
    networkId,
    token: { address: tokenAddress, symbol: walletAsset.symbol, decimals: walletAsset.decimals },
  })
  if (delivered) await store.markReminded(id, Date.now())
  return delivered
}
