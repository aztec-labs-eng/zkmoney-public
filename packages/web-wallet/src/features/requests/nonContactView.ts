import type { PaymentRequest } from "@obsidion/front-core"
import { relativeTimeLabel } from "../../ui/format"

/** Not under `/contacts/:idOrTag`: any tag could match that route. */
export const NON_CONTACT_REQUESTS_PATH = "/requests/non-contacts"

export const requesterHandle = (tag: string) => `@${tag}.zk.money`

/** The Contacts entry's summary line: up to two requesters by name, then a count. */
export function requestersSummary(requests: readonly Pick<PaymentRequest, "contactTag">[]): string {
  const tags = [...new Set(requests.map((r) => r.contactTag))]
  const [first, second] = tags.map(requesterHandle)
  if (tags.length === 1) return `${first} requested funds from you.`
  if (tags.length === 2) return `${first} and ${second} requested funds from you.`
  return `${first}, ${second} and ${tags.length - 2} more requested funds from you.`
}

/** A row's second line: the note (or "No note") and how long ago the request arrived. */
export function requestMeta(
  request: Pick<PaymentRequest, "note" | "createdAt">,
  now: number,
): string {
  return `${request.note?.trim() || "No note"} · ${relativeTimeLabel(request.createdAt, now)}`
}
