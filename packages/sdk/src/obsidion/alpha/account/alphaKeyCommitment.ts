import { Fr } from "@aztec/aztec.js/fields"
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon"
import type { AlphaAuthProvider } from "../auth/AlphaAuthProvider.js"

/** `DOM_SEP__ALPHA_KEY_ID` in `contracts/alpha/lib/src/keys.nr`. Wider than a JS number, so it is prepended as a field. */
const DOM_SEP_ALPHA_KEY_ID = new Fr(0x414c5048415f4b4559n)

/** A 16-byte big-endian half of a coordinate, as `pack_bytes_to_field` folds it. */
function packHalf(bytes: Uint8Array, offset: number): Fr {
  return new Fr(BigInt(`0x${Buffer.from(bytes.subarray(offset, offset + 16)).toString("hex")}`))
}

/** The 64-byte x‖y key as lowercase hex without a prefix; throws on anything else. */
export function normalizePubkeyHex(pubkeyHex: string): string {
  const raw = pubkeyHex.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{128}$/.test(raw))
    throw new Error("alphaKeyCommitment: expected a 64-byte x||y key as hex")
  return raw
}

/** The x‖y hex of an auth provider's signing key, the shape every address derivation takes. */
export async function pubkeyHexOf(provider: AlphaAuthProvider): Promise<string> {
  const [x, y] = await provider.getPubkeys()
  return Buffer.concat([x, y]).toString("hex")
}

/**
 * The account's `immutables_hash`: `compute_key_commitment(x, y)` in the contract, the commitment
 * of the one signing key the account is bound to. `pubkeyHex` is the 64-byte `x‖y` key, with or
 * without a `0x` prefix.
 */
export async function alphaKeyCommitment(pubkeyHex: string): Promise<Fr> {
  const raw = Buffer.from(normalizePubkeyHex(pubkeyHex), "hex")
  const x = raw.subarray(0, 32)
  const y = raw.subarray(32, 64)
  return poseidon2Hash([
    DOM_SEP_ALPHA_KEY_ID,
    packHalf(x, 0),
    packHalf(x, 16),
    packHalf(y, 0),
    packHalf(y, 16),
  ])
}
