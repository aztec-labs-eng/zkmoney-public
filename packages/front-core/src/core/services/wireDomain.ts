import { namehash } from "viem/ens"
import type { Hex } from "viem"

/**
 * Compose the oxide Registry wire-domain node from a BARE wallet tag.
 *
 * Tags are stored bare (`"alice"`); the `@alice.zk.money` form is display chrome
 * only. The Registry registration/resolution node is built here from the bare tag
 * plus the supplied wire domain (`tuple.ensDomain`): `oxidestaging.eth` on testnet,
 * `zk.money` on mainnet (app-overlaid there, since the prod.v4.json entry leaves it empty). Raw
 * `namehash` (no ENS normalize) to stay byte-identical with the oxide
 * `register_name` reference flow.
 *
 * The tag is case-folded first, so a name registers under the one node every resolver
 * looks it up by. Without that a tag claimed as `Alice` lands on a node no payer reaches.
 */
export function composeWireNameHash(bareTag: string, ensDomain: string): Hex {
  return wireNode(bareTag.trim().toLowerCase(), ensDomain)
}

function wireNode(tag: string, ensDomain: string): Hex {
  const domain = ensDomain.trim()
  if (!tag) throw new Error("composeWireNameHash: empty tag")
  if (!domain) throw new Error("composeWireNameHash: empty ensDomain")
  const suffix = `.${domain}`
  const fqdn = tag.endsWith(suffix) ? tag : `${tag}${suffix}`
  return namehash(fqdn)
}

/**
 * Match a candidate tag against a registered wire node. Structural decoration is canonicalized
 * away — whitespace, a leading `@`, a `.${ensDomain}` or display `.zk.money` suffix — and so is
 * case, because a tag only ever registers folded. Returns the bare folded form, so callers
 * persist a tag that keeps matching; null when it does not hash to the node.
 */
export function matchWireNameHash(
  candidate: string | null | undefined,
  ensDomain: string,
  nameHash: Hex,
): string | null {
  if (!candidate) return null
  let bare = candidate.trim()
  if (bare.startsWith("@")) bare = bare.slice(1)
  bare = stripSuffixFold(bare, `.${ensDomain.trim()}`)
  bare = stripSuffixFold(bare, ".zk.money")
  bare = bare.trim()
  if (!bare) return null
  const lower = bare.toLowerCase()
  if (composeWireNameHash(lower, ensDomain).toLowerCase() !== nameHash.toLowerCase()) return null
  return lower
}

function stripSuffixFold(value: string, suffix: string): string {
  return value.toLowerCase().endsWith(suffix.toLowerCase())
    ? value.slice(0, value.length - suffix.length)
    : value
}
