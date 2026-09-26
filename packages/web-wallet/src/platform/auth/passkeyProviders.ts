/**
 * Passkey managers refused at creation by their self-reported id, so the message can name the
 * manager and steer to another. Steering only: the id is self-reported under `attestation: "none"`
 * and sometimes zeroed, and the backup and PRF gates remain the real defense. An entry needs a
 * measurement on a route the wallet uses; nothing measured supports one as of 2026-09-04 (the one
 * provider seen returning no PRF, 1Password's desktop extension, is a supported manager the no-PRF
 * gate already handles), so the list ships empty.
 */
export type UnsupportedProvider = {
  /** Lowercase hyphenated uuid. */
  aaguid: string
  name: string
  /** Route, provider version, date, and where the measurement lives. */
  source: string
}

export const UNSUPPORTED_PASSKEY_AAGUIDS: readonly UnsupportedProvider[] = []

export function unsupportedProviderFor(
  aaguid: string | undefined,
  list: readonly UnsupportedProvider[] = UNSUPPORTED_PASSKEY_AAGUIDS,
): UnsupportedProvider | undefined {
  if (!aaguid) return undefined
  const wanted = aaguid.toLowerCase()
  return list.find((entry) => entry.aaguid === wanted)
}
