/**
 * Deterministic avatar-gradient palette. The same tag must produce the same
 * gradient on every surface — the hash is JS-style `(h << 5) - h + charCode` with 32-bit wrap over the lowercased key.
 */
export const AVATAR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["#A000FF", "#FE708B"],
  ["#A000FF", "#0099FF"],
  ["#0099FF", "#56E79D"],
  ["#FF7A00", "#FE708B"],
  ["#EED04E", "#FF7A00"],
  ["#56E79D", "#0099FF"],
  ["#FE708B", "#A000FF"],
  ["#9907FF", "#2E6DFE"],
]

export function avatarColors(key: string): readonly [string, string] {
  const k = key.toLowerCase()
  let h = 0
  for (let i = 0; i < k.length; i++) {
    h = ((h << 5) - h + k.charCodeAt(i)) | 0
  }
  return AVATAR_PAIRS[Math.abs(h) % AVATAR_PAIRS.length]
}
