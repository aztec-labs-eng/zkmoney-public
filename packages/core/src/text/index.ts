/** Direction overrides and isolates: they let a note reorder the text around it. */
const BIDI_CONTROLS = /\p{Bidi_Control}/gu
/** More marks than any script stacks on one letter: the rest only draw outside the line. */
const MARK_RUN = /(\p{M}{3})\p{M}+/gu

/** Text from another user, safe to lay out: no direction controls, at most 3 marks per letter. */
export function plainText(text: string): string {
  return text.normalize("NFC").replace(BIDI_CONTROLS, "").replace(MARK_RUN, "$1")
}
