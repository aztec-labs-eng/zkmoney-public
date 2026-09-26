import { writeClipboard } from "../ui/hooks"
import { getConfig } from "../config/env"
import { isDemoMode } from "../dev/demoFlag"
import { analyticsUrl, appVersion, reportId } from "../lib/analytics"
import type { ErrorModalPayload } from "./errorModal"

/** Plain-text diagnostic blob for clipboard copy. */
function errorReportText(payload: ErrorModalPayload): string {
  return [
    "zk.money error report",
    `Title: ${payload.title}`,
    `Message: ${payload.message}`,
    payload.detail ? `Detail: ${payload.detail}` : null,
    payload.context ? `Context: ${payload.context}` : null,
    `Time: ${new Date().toISOString()}`,
    `Network: ${getConfig().network}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
}

/** Writes the report to the clipboard. */
export async function copyErrorReport(payload: ErrorModalPayload): Promise<void> {
  await writeClipboard(errorReportText(payload))
}

/**
 * POSTs the report to zkmoney-api /error-reports. Consent is the user's Report click, NOT the
 * analytics consent gate — during user testing we want the stack even from users who declined
 * analytics. Returns whether the API accepted it. Demo mode stubs a success without posting:
 * fixture errors are not real reports, and the Report button should still read "Sent" on a demo
 * walkthrough.
 */
export async function sendErrorReport(payload: ErrorModalPayload): Promise<boolean> {
  if (isDemoMode()) return true
  if (!analyticsUrl) return false
  try {
    const res = await fetch(`${analyticsUrl}/error-reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: payload.title,
        message: payload.message.slice(0, 2_048),
        // Server caps detail at 10k; keep the top of the stack, where the frames that matter are.
        detail: payload.detail?.slice(0, 8_192),
        context: payload.context,
        // Report-scoped id, NOT the analytics id: report free text may carry raw tags/addresses,
        // and sharing the analytics id would let one report de-anonymize the whole event stream.
        session_id: reportId(),
        platform: "web",
        app_version: appVersion,
        env: payload.env,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}
