import {
  normalizeTag,
  recentContacts,
  type ContactActivitySources,
  type ContactRow,
} from "@obsidion/front-core"

/**
 * Who the Send screen offers first: whoever the user last paid, asked or was paid by, saved or not,
 * then saved contacts to fill the list. An unsaved person is a row keyed by their tag.
 */
export function recentPeople(
  contacts: readonly ContactRow[],
  sources: ContactActivitySources,
  limit: number,
): ContactRow[] {
  const savedTags = new Set(
    contacts.flatMap((c) => (c.addressKind === "ethereum-l1" ? [] : [c.tag])),
  )
  const unsaved = new Map<string, ContactRow>()
  const add = (rawTag: string | undefined, address?: string) => {
    const tag = rawTag && !/^0x/i.test(rawTag) ? normalizeTag(rawTag) : null
    if (!tag || savedTags.has(tag)) return
    const known = unsaved.get(tag)
    // The address lets a send, recorded by address, count toward this row.
    if (known) {
      if (!known.address && address) known.address = address
      return
    }
    unsaved.set(tag, { id: tag, name: tag, tag, address: address ?? "", addressKind: "aztec-l2" })
  }
  for (const tx of sources.transactions ?? []) {
    if (!("token" in tx) || !tx.token) continue
    if (tx.action === "send" && "toTag" in tx) add(tx.toTag, tx.to)
    if (tx.action === "receive" && "from" in tx) add(tx.from, tx.senderL2Address)
  }
  for (const request of sources.requests ?? []) if (request.kind !== "link") add(request.contactTag)

  const recent = recentContacts([...contacts, ...unsaved.values()], sources, limit)
  const listed = new Set(recent.map((row) => row.id))
  const fill = contacts
    .filter((c) => !listed.has(c.id))
    .slice(0, Math.max(0, limit - recent.length))
  return [...recent, ...fill]
}
