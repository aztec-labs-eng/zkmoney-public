/** Who a link says paid it: the creator's verified tag, else no one by name. */
export function senderLine(senderTag: string | undefined): string {
  return senderTag ? `@${senderTag} sent you` : "Someone sent you"
}
