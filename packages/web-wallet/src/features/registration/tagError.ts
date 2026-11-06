import { normalizeTag } from "@obsidion/front-core"
import { MAX_TAG_LENGTH } from "@obsidion/core/constants"

/**
 * Why a typed tag was refused, for the inline error under the field. One reason, not the rulebook:
 * the input is checked on every keystroke, so a half-typed tag should not recite every rule it has
 * not broken. `normalizeTag` stays the authority on whether a tag is usable at all; this only
 * explains a no it already returned.
 */
export function tagError(typed: string): string | undefined {
  if (normalizeTag(typed) !== null) return undefined
  const bare = typed
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\.zk\.money$/, "")
  if (!bare) return "Enter a tag"
  if (bare.length > MAX_TAG_LENGTH) return `At most ${MAX_TAG_LENGTH} characters`
  if (!/^[a-z0-9_-]+$/.test(bare)) return "Letters, numbers and hyphens only"
  if (bare.startsWith("-") || bare.endsWith("-")) return "No leading or trailing hyphen"
  if (/[^_]_/.test(bare)) return "Underscores only at the start"
  return "No double hyphen in the 3rd and 4th place"
}
