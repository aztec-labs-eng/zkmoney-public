import { writeClipboard } from "../ui/hooks"
import type { Network } from "@obsidion/core/constants"
import { bestEffort, scrubErrorText, WalletError } from "@obsidion/core/errors"
import { isDemoMode } from "../dev/demoFlag"
import { analyticsUrl, appVersion, reportId } from "../lib/analytics"
import type { ErrorModalPayload } from "./errorModal"

/** Plain-text diagnostic blob for clipboard copy. */
function errorReportText(payload: ErrorModalPayload, network: Network): string {
  return [
    "zk.money error report",
    `Title: ${payload.title}`,
    `Message: ${payload.message}`,
    payload.detail ? `Detail: ${payload.detail}` : null,
    payload.context ? `Context: ${payload.context}` : null,
    `Time: ${new Date().toISOString()}`,
    `Network: ${network}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
}

/** Writes the report to the clipboard. */
export async function copyErrorReport(payload: ErrorModalPayload, network: Network): Promise<void> {
  await writeClipboard(errorReportText(payload, network))
}

/** A `WalletError`'s code and scrubbed detail, else the error's scrubbed message or name. */
function reportedMessage(error: Error): string {
  if (error instanceof WalletError)
    return error.detail ? `${error.code}: ${scrubErrorText(error.detail)}` : error.code
  return scrubErrorText(error.message) || scrubErrorText(error.name)
}

/**
 * POSTs the report to zkmoney-api /error-reports, which stores it or passes it on to Sentry. The
 * text is scrubbed here, so no raw message leaves the device, and the stack goes as frames of the
 * wallet's own scripts. The parser loads on this click: nothing of Sentry's runs before it. Consent
 * is the user's Report click, NOT the analytics consent gate — during user testing we want the
 * stack even from users who declined analytics. Returns whether the API accepted it. Demo mode
 * stubs a success without posting: fixture errors are not real reports, and the Report button
 * should still read "Sent" on a demo walkthrough.
 */
export async function sendErrorReport(payload: ErrorModalPayload): Promise<boolean> {
  if (isDemoMode()) return true
  if (!analyticsUrl) return false
  const { error } = payload
  const stack = error?.stack
  const frames = stack
    ? await bestEffort(
        "unknown",
        import("./stackFrames").then((m) => m.stackFrames(stack, window.location.origin)),
      )
    : undefined
  try {
    const res = await fetch(`${analyticsUrl}/error-reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: scrubErrorText(payload.title),
        message: (error ? reportedMessage(error) : scrubErrorText(payload.message)).slice(0, 2_048),
        type: error && scrubErrorText(error.name).slice(0, 64),
        frames,
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
