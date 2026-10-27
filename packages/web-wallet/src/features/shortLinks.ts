import { useEffect, useRef, useState } from "react"
import { decodePaylinkInline, encodeLinkFragment, LinkKind, Network } from "@obsidion/sdk"
import { getConfig } from "../config/env"
import { zkMoneyLinkHostEnabled } from "../config/features"
import { requestLinkOrigin } from "./requests/requestLinkCreation"

/** The zk.money apex for this network, once it routes short links. */
function apex(): string | undefined {
  if (!zkMoneyLinkHostEnabled) return undefined
  return getConfig().network === Network.MAINNET ? "https://zk.money" : "https://staging.zk.money"
}

function seedOf(fragment: string): Uint8Array | undefined {
  try {
    return decodePaylinkInline(fragment).seed
  } catch {
    return undefined
  }
}

function shortPaylinkUrl(seed: Uint8Array): string {
  const short = encodeLinkFragment(LinkKind.Paylink, seed)
  const host = apex()
  return host ? `${host}/p#${short}` : `${location.origin}/link#${short}`
}

/** The full link a paylink row stores, which refunds, migration and status reads decode. */
export function paylinkRowUrl(fragment: string): string {
  return `${location.origin}/link#${fragment}`
}

/** The URL to share for a row's stored full link: its short link, or the link as stored. */
export function paylinkRowShareUrl(stored: string): string {
  const seed = seedOf(stored.slice(stored.indexOf("#") + 1))
  return seed ? shortPaylinkUrl(seed) : stored
}

/** The URL to share for a paylink fragment: the short link when the fragment carries its seed. */
export function paylinkShareUrl(fragment: string): string {
  const seed = seedOf(fragment)
  return seed ? shortPaylinkUrl(seed) : `${location.origin}/link#${fragment}`
}

/** No tag in the path: a path reaches the host and link-preview bots, and the payload names the payee. */
export function shortRequestUrl(seed: Uint8Array): string {
  const fragment = encodeLinkFragment(LinkKind.Request, seed)
  const host = apex()
  return host ? `${host}/r#${fragment}` : `${requestLinkOrigin()}/request#${fragment}`
}

/** How often a short link that isn't on chain yet is looked up again. */
const SHORT_LINK_RETRY_MS = 5_000

/**
 * Look a short link up until its announcing tx lands, then hand its full fragment to `open`.
 * `refusal` names an error that ends the lookup; the hook returns its message.
 */
export function useShortLinkLookup(
  resolve: (() => Promise<string | undefined>) | undefined,
  open: (fragment: string) => void,
  refusal?: (error: unknown) => string | undefined,
): string | undefined {
  const [refused, setRefused] = useState<string>()
  const latest = useRef({ open, refusal })
  latest.current = { open, refusal }

  useEffect(() => {
    if (!resolve) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const attempt = async () => {
      try {
        const fragment = await resolve()
        if (stopped) return
        if (fragment) return latest.current.open(fragment)
      } catch (e) {
        if (stopped) return
        const message = latest.current.refusal?.(e)
        if (message) return setRefused(message)
        console.warn("[short link] lookup failed:", e)
      }
      timer = setTimeout(() => void attempt(), SHORT_LINK_RETRY_MS)
    }
    void attempt()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [resolve])

  return refused
}
