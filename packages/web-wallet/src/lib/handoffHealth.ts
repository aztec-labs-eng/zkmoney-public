/**
 * The campaign hand-off's health counts: what this page load did with a hand-off, and where the key
 * of an adopted campaign account came from. Each is sent once per page load on the identifier-free
 * signup channel. Neither is a signup: `wallet_entered` reports that, with consent.
 */
import { fireSignupEvent, type HandoffAdoption, type HandoffReceipt } from "./analytics"

let received: HandoffReceipt | undefined
let adopted = false

/** What this page load did with its hand-off. Only the first report counts. */
export function reportHandoffReceipt(receipt: HandoffReceipt): void {
  if (received) return
  received = receipt
  fireSignupEvent({ event: "handoff_received", props: receipt })
}

/** The adoption of a campaign hand-off's account, once per page load. */
export function reportHandoffAdopted(keySource: HandoffAdoption["key_source"]): void {
  if (adopted) return
  adopted = true
  const material = received?.receipt === "accepted" ? "accepted" : "none"
  fireSignupEvent({ event: "handoff_adopted", props: { key_source: keySource, material } })
}

export function __resetHandoffHealthForTests(): void {
  received = undefined
  adopted = false
}
