/**
 * Registry user-record read — the forward-resolution primitive behind
 * send-to-tag. Names and metadata sit in separate registries, so this composes
 * `readUserAddress` on the NameRegistry (nameHash → account address) with
 * `getUserRecord` on the AccountMetadataRegistry (account address → UserRecord),
 * returning the recipient's on-chain record or `null` when the name resolves to
 * nothing.
 *
 * Lives in sdk because these are contract reads; front-core never originates a
 * contract call — it composes this primitive with the wire-nameHash builder in
 * `RegistryTagResolver`.
 */

import type { Address, Hex, PublicClient } from "viem"
import {
  getBootstrapOwner,
  getUserRecord,
  hasUserRecord,
  readUserAddress,
  type K1PointArg,
} from "@oxide/l1-contracts"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export interface RegistryUserRecord {
  /** The recipient's L1 OxideAccount address (resolved from `nameHash`). */
  account: Address
  /**
   * The account's bootstrap EOA (`OxideAccount.bootstrapOwner()`). The wallet associates this
   * address with its XMTP inbox, so it is the recipient's messaging address.
   */
  bootstrapOwner: Address
  /** The recipient's Aztec L2 account address (32-byte field element as hex). */
  l2Address: Hex
  /**
   * The recipient's secp256k1 SIPA deposit key (`K1Point`, x‖y serialization)
   * used to derive stealth deposit addresses. This is NOT the legacy Aztec
   * `masterTaggingPublicKey` — different key, different curve (secp256k1 vs
   * Grumpkin), different serialization. The old field name must never be reused
   * for this value.
   */
  sipaStealthPublicKey: K1PointArg
  /** Rollup the record is scoped to; a mismatch means the recipient is stale. */
  rollupVersion: bigint
}

/**
 * Read the user record `nameHash` resolves to. Returns `null` ONLY for a
 * permanent absence — the name owns no account, or that account carries no
 * record in the AccountMetadataRegistry; any RPC / transport failure propagates
 * as a throw. The forward-resolution contract treats null as absence and a
 * throw as a retryable transport error, so the two must never be conflated.
 *
 * The `hasUserRecord` probe is load-bearing: `getUserRecord` REVERTS for an
 * account with no record, and at the call site a revert is indistinguishable
 * from a transport failure.
 */
export async function readUserByNameHash(
  publicClient: PublicClient,
  nameRegistry: Address,
  accountMetadataRegistry: Address,
  nameHash: Hex,
): Promise<RegistryUserRecord | null> {
  const account = await readUserAddress(publicClient, nameRegistry, nameHash)
  if (account.toLowerCase() === ZERO_ADDRESS) return null
  if (!(await hasUserRecord(publicClient, accountMetadataRegistry, account))) return null
  const [record, bootstrapOwner] = await Promise.all([
    getUserRecord(publicClient, accountMetadataRegistry, account),
    getBootstrapOwner(publicClient, account),
  ])
  return {
    account,
    bootstrapOwner,
    l2Address: record.l2Address,
    sipaStealthPublicKey: record.publicKey,
    rollupVersion: record.rollupVersion,
  }
}
