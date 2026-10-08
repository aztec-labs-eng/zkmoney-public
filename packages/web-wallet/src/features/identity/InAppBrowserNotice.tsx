import type { ReactNode } from "react"
import { IN_APP_UP_FRONT_COPY as COPY } from "@obsidion/passkey-web"
import { showReportableError } from "../../errors/errorModal"
import { OpenInBrowser } from "./OpenInBrowser"

/**
 * The way out of an app's built-in browser, shown in place of the passkey button before any
 * request. Nothing has failed, so there is no retry, and no way to try here. The report carries the
 * user agent, the one thing that can show a wrongly matched browser.
 */
export function InAppBrowserNotice({
  exits,
  reportContext,
  testId = "in-app-notice",
}: {
  exits?: ReactNode
  reportContext: string
  testId?: string
}) {
  return (
    <div className="ww-invite-spinner" data-testid={testId}>
      <h2 className="ww-passkey-refusal__title">{COPY.title}</h2>
      <p className="ww-paylink-summary__caption">{COPY.line}</p>
      <OpenInBrowser />
      {exits}
      <button
        type="button"
        className="zkm-btn-reset ww-invite__link ww-escape__report"
        data-testid="passkey-report"
        onClick={() =>
          showReportableError(
            Object.assign(new Error(navigator.userAgent), { name: "InAppBrowserNotice" }),
            reportContext,
            { title: "In-app browser notice" },
          )
        }
      >
        Report this issue
      </button>
    </div>
  )
}
