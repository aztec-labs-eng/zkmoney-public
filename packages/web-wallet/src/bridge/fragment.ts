/**
 * The wallet half of the sealed hand-off (see `sealed.ts` in `@obsidion/passkey-web`). The fragment
 * comes off the URL before anything else boots, so no router, analytics or error report sees it.
 * The material is held in memory for the onboarding take.
 */
import {
  HANDOFF_FRAGMENT_PARAM,
  handoffCookie,
  isHandoffId,
  openHandoff,
  readHandoffCookie,
  sharedCookieDomain,
  validateBridgeMessage,
  type BridgeMessage,
} from "@obsidion/passkey-web"
import { campaignOriginFrom } from "../config/campaignOrigin"
import type { HandoffReceipt, HandoffRejection } from "../lib/analytics"
import { holdHandoffMaterial, type HandoffMaterial } from "../platform/storage/handoffMaterial"

export function takeHandoffFragment(
  loc: Location = window.location,
  history: History = window.history,
): string | null {
  const sealed = new URLSearchParams(loc.hash.slice(1)).get(HANDOFF_FRAGMENT_PARAM)
  if (!sealed) return null
  history.replaceState(history.state, "", `${loc.pathname}${loc.search}`)
  return sealed
}

/** A campaign claim hand-off (launch-campaign-web `walletHandoffUrl`), sealed or plain. */
export function isCampaignClaimArrival(loc: Pick<Location, "pathname" | "search">): boolean {
  const params = new URLSearchParams(loc.search)
  return (
    loc.pathname.startsWith("/claim/") &&
    params.get("src") === "campaign" &&
    params.get("entry") === "passkey"
  )
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return ""
  }
}

function materialFrom(m: BridgeMessage): HandoffMaterial {
  return {
    v: 1,
    derivedAt: m.derivedAt,
    rpId: m.rpId,
    credentialId: m.credentialId,
    pubkeyHex: `0x${m.pubkeyHex}`,
    candidates: m.candidates,
    ...(m.slot ? { slot: m.slot } : {}),
    ...(m.transports ? { transports: m.transports } : {}),
  }
}

export type FragmentEnv = { campaignUrl: string | undefined; rpId: string }

const rejected = (rejection: HandoffRejection): HandoffReceipt => ({
  receipt: "rejected",
  rejection,
})

/**
 * Any host on the shared domain can write the cookie, so a tab counts only when the campaign opened
 * it: the referrer stands in for the sender check. Only a validated hand-off consumes its own
 * cookie; rejected fragments leave pending hand-offs untouched until their cookies expire. The
 * receipt says which check refused it, in closed words.
 */
export async function receiveHandoffFragment(
  fragment: string,
  env: FragmentEnv,
  doc: Document = document,
  hold: (material: HandoffMaterial) => void = holdHandoffMaterial,
): Promise<HandoffReceipt> {
  const campaignOrigin = campaignOriginFrom(env.campaignUrl)
  if (!campaignOrigin || originOf(doc.referrer) !== campaignOrigin) {
    return rejected("not_from_campaign")
  }
  const [id, sealed, extra] = fragment.split(".")
  if (!id || !isHandoffId(id) || !sealed || extra !== undefined) return rejected("malformed")
  const secure = doc.location.protocol === "https:"
  const domain = sharedCookieDomain(doc.location.hostname, new URL(campaignOrigin).hostname)
  if (domain === null) return rejected("no_shared_domain")
  const key = readHandoffCookie(doc.cookie, secure, id)
  if (!key) return rejected("no_key")
  const opened = await openHandoff(key, sealed)
  if (opened === null) return rejected("unreadable")
  const verdict = validateBridgeMessage(opened, { rpId: env.rpId })
  if (!verdict.ok) return rejected("invalid")
  doc.cookie = handoffCookie("", domain, secure, id, 0)
  hold(materialFrom(verdict.message))
  return { receipt: "accepted" }
}
