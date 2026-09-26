/** Wire layout of a persisted CompleteAddress hex blob (0x-optional). */
export type CompleteAddressWireFormat = "v4" | "v5" | "unknown"

/** v4 CompleteAddress is 320 bytes; v5 is 288. */
export function completeAddressWireFormat(hex: string): CompleteAddressWireFormat {
  const hexChars = hex.replace(/^0x/i, "").length
  if (hexChars % 2 !== 0) return "unknown"
  const byteLength = hexChars / 2
  if (byteLength === 320) return "v4"
  if (byteLength === 288) return "v5"
  return "unknown"
}
