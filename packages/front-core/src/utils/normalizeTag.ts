import { normalize } from "viem/ens"
import { MAX_TAG_LENGTH } from "@obsidion/core/constants"

/**
 * The X handle alphabet (`A-Za-z0-9_`, folded below) plus `-`, which the wallet's own generated
 * tags use ("honk-goose"). Hyphens may not lead or trail: a tag is rendered as the
 * `<tag>.zk.money` subdomain label in QR and handshake links.
 */
const TAG_CHARSET = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/

/**
 * The one tag entry point. Folds a tag to its bare lowercase form, stripping surrounding space, a
 * leading `@` and a `.zk.money` suffix, and returns that form only when it is one the wallet can
 * claim and every resolver can look up. Returns null when it is not.
 *
 * A tag is an ENS label: registration hashes `<tag>.<ensDomain>` and `zk.money` is the mainnet
 * domain. Nothing downstream re-checks it, since `composeWireNameHash` hashes raw and the claim
 * server only ever sees the 32-byte node, so ENSIP-15 is enforced here, by the same normalizer
 * every ENS client runs rather than by restating its rules. The charset alone would leak
 * `bob_smith` (underscore past the leading run) and `xn--foo` (`--` in the 3rd and 4th position),
 * both of which register under a node nothing resolves.
 *
 * Callers that must not fold — a wire decoder owes its caller the exact bytes it was handed —
 * compare instead of assigning: `normalizeTag(v) === v` holds only for a tag already bare,
 * lowercase and usable, so "Alice" is rejected rather than quietly rewritten.
 */
export function normalizeTag(input: string): string | null {
  let tag = input.trim().toLowerCase()
  if (tag.startsWith("@")) tag = tag.slice(1)
  if (tag.endsWith(".zk.money")) tag = tag.slice(0, -9)
  if (!tag || tag.length > MAX_TAG_LENGTH || !TAG_CHARSET.test(tag)) return null
  try {
    return normalize(tag) === tag ? tag : null
  } catch {
    return null
  }
}
