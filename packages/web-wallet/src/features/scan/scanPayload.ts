import {
  decodeInline,
  isPaymentContactEntry,
  navigateIdFor,
  normalizeTag,
  parseConnectLink,
  parseUserTagFromQRPayload,
  type Contact,
} from "@obsidion/front-core"
import { previewConnect } from "../contacts/connectReceive"
import { pastedLinkRoute } from "../paylink/pastedLink"

export type ScanDestination = { to: string; state?: { searchTag: string } }
export type ScanResult =
  | { kind: "destination"; destination: ScanDestination }
  | { kind: "error"; message: string }

interface ScanIdentity {
  ownTag?: string
  ownL2Address?: string
  contacts: Contact[]
}

/** Camera and manual paste share this route adapter; destination screens own confirmation. */
export async function scanPayload(text: string, identity: ScanIdentity): Promise<ScanResult> {
  const payload = text.trim()
  const error = (message: string): ScanResult => ({ kind: "error", message })
  const route = (to: string, state?: { searchTag: string }): ScanResult => ({
    kind: "destination",
    destination: { to, ...(state ? { state } : {}) },
  })
  if (!payload) return error("Scan a wallet QR code or paste a link or @tag.")

  const packet = parseConnectLink(payload)
  if (packet) {
    const preview = await previewConnect(payload, { decodeInline, ...identity })
    if (preview.kind === "self-scan") return error("This is your own code.")
    if (preview.kind === "error") return error("This connect code is invalid. Try another code.")
    return route(`/connect#${packet}`)
  }
  if (/(?:^|\/)connect(?:[\/#?]|$)/i.test(payload)) {
    return error("This connect link is invalid. Use the complete wallet connect link.")
  }

  const contacts = identity.contacts.filter(isPaymentContactEntry)
  const link = pastedLinkRoute(payload)
  if (link) return route(link)

  if (/^0x/i.test(payload)) {
    if (!/^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(payload)) {
      return error("This address is invalid. Use a wallet link or registered @tag.")
    }
    if (identity.ownL2Address?.toLowerCase() === payload.toLowerCase())
      return error("This is your own address.")
    const contact = contacts.find(
      (entry) => entry.address.toLowerCase() === payload.toLowerCase(),
    )
    return contact
      ? route(`/contacts/${encodeURIComponent(navigateIdFor(contact))}`)
      : error("This address is not a saved contact. Scan a wallet link or registered @tag instead.")
  }

  const tag = normalizeTag(parseUserTagFromQRPayload(payload) ?? payload)
  if (!tag) return error("This code isn't supported. Use a wallet link or registered @tag.")
  if (identity.ownTag && tag === normalizeTag(identity.ownTag))
    return error("This is your own @tag.")
  const contact = contacts.find((entry) => entry.tag === tag)
  return contact
    ? route(`/contacts/${encodeURIComponent(navigateIdFor(contact))}`)
    : route("/contacts", { searchTag: tag })
}
