/**
 * Registration-by-deposit payload encoding (registration-fee.md §SIPA / §Registry).
 *
 * `registrationData` is the registration intent's `intentData`: `abi.encode(bytes recordData,
 * uint256 fee, address beneficiary, bytes32 recipientCommitment, bytes32 namePortalRecipient)`,
 * where `recordData` is
 * `abi.encode(address owner, bytes32 nameHash, AccountMetadataRegistry.UserRecord record)`. The
 * registration SIPA is a `RegistrationSIPA` intent whose single committed word is `intentHash =
 * keccak256(registrationData)`, so any variant — a swapped routing key, a different fee or
 * beneficiary — is a different SIPA address the payer never funded. The sweep pays exactly the
 * committed fee to the committed beneficiary; the controller only checks them, so a controller
 * swapped in after the deposit can refuse the registration but not re-price it.
 *
 * Both ABI codecs are oxide's own, never a local transcription: a client that encodes one byte
 * differently derives a SIPA address no relayer can sweep, stranding the deposit at an address only
 * the payer ever knew.
 *
 * `consentSig` uses the account signature rules for `consentDigest` over
 * `recordData` alone plus the chain and the AccountMetadataRegistry: binding a registry rather than
 * the controller keeps a consent valid across a controller roll, and it cannot be replayed across
 * chains or registries.
 */

import { type Hex, encodeAbiParameters, keccak256 } from "viem"
import { encodeRegistrationIntentData, encodeRegistrationRecord } from "@oxide/l1-contracts"
import type { RegistrationIntent, UserRecord } from "@obsidion/core/types"

/** The identity slice the controller decodes and the owner's consent signature covers. */
export function encodeUserRecord(owner: Hex, nameHash: Hex, record: UserRecord): Hex {
  return encodeRegistrationRecord(owner, nameHash, record)
}

/** ABI-encode the full intent — the `registrationData` bytes the SIPA commits to and the sweep decodes. */
export function encodeRegistrationData(intent: RegistrationIntent): Hex {
  return encodeRegistrationIntentData(intent)
}

/** `keccak256(registrationData)` — the registration intent's `intentHash` (its single committed word). */
export function registrationCommitment(intent: RegistrationIntent): Hex {
  return keccak256(encodeRegistrationData(intent))
}

/**
 * The consent digest the owner's bootstrap key signs: `keccak256(abi.encode(recordData, chainId,
 * accountMetadataRegistry, sipa))`, matching `RegistrationController._consentDigest`. This is a RAW
 * keccak digest — the signer must sign it directly, with no EIP-191/EIP-712 prefix.
 *
 * `accountMetadataRegistry` must be `NameRegistry.accountMetadataRegistry()` read on chain at
 * signing time: the pointer is owner-mutable and the controller resolves it live at sweep time, so
 * a manifest-cached value signs a consent the sweep rejects — with the deposit already paid.
 *
 * `sipa` is the address that settles the registration; the controller passes its own `msg.sender`.
 * One signature therefore authorizes one clone. The routing words beside the record are bound
 * transitively: the address commits to the whole intent, so a re-encoded payload lands at an
 * address the owner never signed for — including a rival allowlisted beneficiary's.
 */
export function consentDigest(
  recordData: Hex,
  chainId: number | bigint,
  accountMetadataRegistry: Hex,
  sipa: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
      [recordData, BigInt(chainId), accountMetadataRegistry, sipa],
    ),
  )
}
