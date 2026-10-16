import { concatHex, keccak256, toBytes, toHex, type Hex } from "viem"
import type { Fr } from "@aztec/aztec.js/fields"
import { L2_BINDING_MESSAGE_PREFIX } from "@obsidion/core/constants"
import type { OxideAccountBinding } from "@obsidion/sdk"
import { deriveBootstrapKey } from "./oxideAccountKeys"

/** Shared web/mobile NameClaim and attestation binding to the destination L2 account. */
export async function metadataMigrationBinding(
  secretKey: Fr,
  recipient: Hex,
  nameHash: Hex,
): Promise<OxideAccountBinding> {
  const bootstrap = deriveBootstrapKey(secretKey)
  const publicKey = toBytes(bootstrap.publicKey)
  const signature = await bootstrap.sign({
    hash: keccak256(
      concatHex([toHex(new TextEncoder().encode(L2_BINDING_MESSAGE_PREFIX)), recipient]),
    ),
  })
  return {
    nameHash: toBytes(nameHash),
    bootstrapPubKeyX: publicKey.slice(1, 33),
    bootstrapPubKeyY: publicKey.slice(33, 65),
    bindingSig: toBytes(signature).slice(0, 64),
  }
}
