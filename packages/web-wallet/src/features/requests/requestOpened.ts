import { fireEvent, requestAmountBucket } from "../../lib/analytics"

/** Where a payer opened a request. `pay_page` is a payee's standing `/pay/<tag>` page. */
export type RequestSource = "contact" | "link" | "pay_page"

const opened = new Set<string>()

/**
 * `request_opened`, once per request per page load: switching between the send sheet and the
 * Ethereum route remounts both. A pay page draws a new id on each mount, so its tag is the key.
 */
export function fireRequestOpened(source: RequestSource, id: string, amount: number, tag?: string) {
  const key = source === "pay_page" ? `pay_page:${tag}` : id
  if (opened.has(key)) return
  opened.add(key)
  fireEvent("request_opened", { source, amount_bucket: requestAmountBucket(amount) })
}
