const SEPARATORS = new Set([",", "٫", "．", "，"])

// Every decimal digit the runtime can format, keyed by glyph. Algorithmic systems (roman…) are filtered out.
const DIGITS = new Map<string, string>()
for (const numberingSystem of Intl.supportedValuesOf("numberingSystem"))
  for (let d = 0; d <= 9; d++) {
    const glyph = new Intl.NumberFormat("en", { numberingSystem }).format(d)
    if (/^\p{Nd}$/u.test(glyph)) DIGITS.set(glyph, String(d))
  }

/**
 * Ungrouped amount entry: dot, comma or Arabic decimal separators and localized digits folded to
 * ASCII, every other character kept so validation still sees it. Never goes through a JS number.
 */
export function normalizeAmountInput(text: string): string {
  return Array.from(text, (c) => (SEPARATORS.has(c) ? "." : DIGITS.get(c) ?? c)).join("")
}

/** After decimal syntax/precision validation, can the UI's number preserve every cent? */
export function isSafeAmountNumber(text: string): boolean {
  const [whole, fraction = ""] = text.split(".")
  const digits = fraction.replace(/0+$/, "")
  return String(Number(text)) === `${BigInt(whole || "0")}${digits && `.${digits}`}`
}
