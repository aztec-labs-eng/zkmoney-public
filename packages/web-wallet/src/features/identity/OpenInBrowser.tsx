import { useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import {
  OPEN_IN_BROWSER_COPY as COPY,
  currentAppDropsOpenLink,
  currentOpenInBrowserHref,
} from "@obsidion/passkey-web"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { useCopy } from "../../ui/hooks"
import { hasConnectStash } from "../contacts/connectReceive"
import { pageNameGrantToken } from "../onboarding/nameGrant"
import { peekClaimStash } from "../paylink/claimStash"

const REOPEN = "Open the link you were sent again, in your phone's browser."
const REOPEN_AFTER_HINT = "Or open the link you were sent again, in your phone's browser."

type WayOut =
  | { kind: "none" }
  | { kind: "hint" }
  | { kind: "reopen" }
  | { kind: "link"; href: string; url: string }

/**
 * What a way out to the phone's browser can carry. A built link is the address without its
 * fragment; the app's own menu opens the whole address; nothing carries this browser's storage or
 * router memory, so there only the link the user was sent can start again.
 */
function wayOut(path: string | undefined, routerState: unknown): WayOut {
  const { origin, pathname, search, hash } = window.location
  const url = `${origin}${path ?? `${pathname}${search}`}`
  const href = currentOpenInBrowserHref(url)
  if (!href) return { kind: "none" }
  if (hash || new URLSearchParams(search).get("next")?.includes("#")) return { kind: "hint" }
  const grant = pageNameGrantToken(new URL(window.location.href))
  if (routerState != null || peekClaimStash() || hasConnectStash() || grant) {
    return { kind: "reopen" }
  }
  return { kind: "link", href, url }
}

export type EscapeRetry = { onClick: () => void; busy: boolean; testId: string }

/**
 * The way out of an app's built-in browser, shown from the start beside the refusal, then the
 * refusal's retry: a pill once Open in browser is the primary action. `path` names the wallet page
 * to open there instead of this one.
 */
export function OpenInBrowser({ path, retry }: { path?: string; retry?: EscapeRetry }) {
  const { state } = useLocation()
  const way = wayOut(path, state)
  const linkDropped = currentAppDropsOpenLink()
  const { copied, copy } = useCopy()
  const [copyFailed, setCopyFailed] = useState(false)
  /** Bumped per copy: any copy that lands clears the failure, only the latest can report one. */
  const latestCopy = useRef(0)

  const copyLink = async (url: string) => {
    const mine = ++latestCopy.current
    setCopyFailed(false)
    const ok = await copy(url)
    if (ok || mine === latestCopy.current) setCopyFailed(!ok)
  }
  const copyLabel = copied ? COPY.copied : COPY.copyLink
  const status = (
    <p className="ww-escape__status" aria-live="polite">
      {copied ? COPY.copiedStatus : copyFailed ? COPY.copyFailed : ""}
    </p>
  )

  return (
    <>
      {way.kind !== "none" && (
        <div className="ww-escape" data-testid="open-in-browser" data-escape={way.kind}>
          {way.kind === "link" && linkDropped ? (
            // Where the app drops the link, Copy link leads and the app's own menu follows.
            <>
              <p className="ww-escape__url">{way.url}</p>
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable zkm-primary-btn zkm-primary-btn--gradient ww-escape__open"
                onClick={() => void copyLink(way.url)}
              >
                <span className="zkm-primary-btn__label">{copyLabel}</span>
              </button>
              {status}
              <p className="ww-escape__hint">{COPY.xMenu}</p>
            </>
          ) : way.kind === "link" ? (
            <>
              <a
                className="zkm-pressable zkm-primary-btn zkm-primary-btn--gradient ww-escape__open"
                data-testid="open-in-browser-link"
                href={way.href}
              >
                <span className="zkm-primary-btn__label">{COPY.open}</span>
              </a>
              <p className="ww-escape__hint">{COPY.hint}</p>
              <p className="ww-escape__url">{way.url}</p>
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-invite-pill"
                onClick={() => void copyLink(way.url)}
              >
                {copyLabel}
              </button>
              {status}
            </>
          ) : (
            <>
              {way.kind === "hint" && (
                <p className="ww-escape__hint">{linkDropped ? COPY.xMenuAlone : COPY.hintAlone}</p>
              )}
              <p className="ww-escape__hint">{way.kind === "hint" ? REOPEN_AFTER_HINT : REOPEN}</p>
            </>
          )}
        </div>
      )}
      {retry &&
        (way.kind === "link" ? (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-invite-pill"
            data-testid={retry.testId}
            disabled={retry.busy}
            onClick={retry.onClick}
          >
            Try again
          </button>
        ) : (
          <PrimaryGradientButton
            title="Try again"
            testId={retry.testId}
            isLoading={retry.busy}
            onClick={retry.onClick}
          />
        ))}
    </>
  )
}
