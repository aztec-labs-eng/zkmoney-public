/**
 * Mint input for the mutual-add notice: someone redeemed one of our connect links, their
 * connect-back arrived, and `ConnectBackReceiver` added them back without asking. No producer —
 * the receiver's mount is the event source, so the mint rides that call site.
 */

import { navigateIdFor } from "../../handshake/scanCore"
import type { Contact } from "../../storages/ContactStorage"
import { shortenAddressSm } from "../../../utils/shortenAddr"
import type {
  ContactAddedNotificationTarget,
  CreateAppNotificationInput,
} from "./AppNotificationStore"

export const CONTACT_ADDED_PRODUCER_ID = "contactAdded"

/** Tag-less connect-backs are stored handle-only, so the row is keyed on the XMTP address. */
export function contactAddedNotificationInput(
  contact: Contact,
  timestampMs: number,
): CreateAppNotificationInput {
  const sourceId = contact.address.toLowerCase()
  const display = contact.tag ? `@${contact.tag}` : shortenAddressSm(contact.address)
  const target: ContactAddedNotificationTarget = {
    type: "contact.added",
    contactId: navigateIdFor(contact),
  }
  return {
    id: `contact:added:${sourceId}`,
    producer: CONTACT_ADDED_PRODUCER_ID,
    domain: "contacts",
    sourceId,
    title: "New contact",
    description: `${display} connected using your link`,
    timestampMs,
    systemIcon: "person.crop.circle.badge.plus",
    severity: "success",
    target,
  }
}
