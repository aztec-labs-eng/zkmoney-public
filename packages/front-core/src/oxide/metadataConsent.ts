import {
  encodeR1UserOpSignature,
  getAuthKeys,
  getBootstrapOwner,
  type R1PublicKeyArg,
} from "@oxide/l1-contracts"
import type { Address, Hex, PrivateKeyAccount, PublicClient } from "viem"
import { toWebAuthnAuthArg, type PasskeySignResult } from "./oxideWebAuthn"

export interface MetadataConsentSigner {
  client: PublicClient
  owner: Address
  bootstrap: PrivateKeyAccount
  passkey?: {
    publicKey: R1PublicKeyArg
    signChallenge(challenge: Hex): Promise<PasskeySignResult>
  }
}

/** Receives Oxide's PersonalSign digest, already domain-separated for this account. */
export async function signMetadataConsent(deps: MetadataConsentSigner, digest: Hex): Promise<Hex> {
  const keys = await getAuthKeys(deps.client, deps.owner)
  if (keys.length === 0) {
    const owner = await getBootstrapOwner(deps.client, deps.owner)
    if (owner.toLowerCase() !== deps.bootstrap.address.toLowerCase()) {
      throw new Error("The wallet bootstrap key does not control the registered account")
    }
    return deps.bootstrap.sign({ hash: digest })
  }
  const passkey = deps.passkey
  const index = keys.findIndex(
    ({ key }) =>
      key.qx.toLowerCase() === passkey?.publicKey.qx.toLowerCase() &&
      key.qy.toLowerCase() === passkey?.publicKey.qy.toLowerCase(),
  )
  if (!passkey || index < 0) {
    throw new Error("Use an installed passkey to authorize the metadata update")
  }
  const assertion = await passkey.signChallenge(digest)
  return encodeR1UserOpSignature(BigInt(index), toWebAuthnAuthArg(assertion))
}
