import { isDemoMode } from "../dev/demoFlag"
import { analyticsUrl, appVersion, reportId } from "./analytics"

export type FeedbackPayload = {
  kind: "feedback" | "bug"
  rating?: "good" | "bad"
  text: string
}

/**
 * POSTs a settings feedback / bug-report submission to zkmoney-api /feedback, which relays it as
 * email via Mailgun. Consent is the Send click, NOT the analytics consent gate — same rationale as
 * sendErrorReport. Returns whether the relay accepted it. Demo mode stubs a success without
 * posting, so fixture walkthroughs never email anyone.
 */
export async function sendFeedback(payload: FeedbackPayload): Promise<boolean> {
  if (isDemoMode()) return true
  if (!analyticsUrl) return false
  try {
    const res = await fetch(`${analyticsUrl}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: payload.kind,
        rating: payload.rating,
        text: payload.text.trim().slice(0, 4_096) || undefined,
        // Report-scoped id, NOT the analytics id: free text may carry raw tags/addresses, and
        // sharing the analytics id would let one submission de-anonymize the whole event stream.
        session_id: reportId(),
        platform: "web",
        app_version: appVersion,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}
