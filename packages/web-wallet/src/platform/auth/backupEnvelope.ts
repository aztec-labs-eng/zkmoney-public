/**
 * The wallet's opener for a backup passkey's envelope: the master key sealed under that passkey's
 * PRF output and bound to its account and credential. The assertion must carry user verification.
 * Its PRF slots are read without the backup gate: the envelope proves the key, so a device-bound
 * copy may open it.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PasskeyEnvelopeError, openMasterKey } from "@obsidion/front-core"
import {
  type PasskeyAssertResult,
  evidenceOf,
  parseAuthenticatorDataFlags,
  prfOutputsOf,
} from "@obsidion/passkey-web"
import type { Address } from "viem"

export interface BackupEnvelope {
  envelope: Uint8Array
  /** The oxide account the envelope is bound to. */
  account: Address
  /** The answering passkey's, base64url. */
  credentialId: string
}

/** Whether the authenticator verified the user; data too short to say fails closed. */
function userVerified(assertion: PasskeyAssertResult): boolean {
  try {
    return parseAuthenticatorDataFlags(assertion.authenticatorData).userVerified
  } catch {
    return false
  }
}

/**
 * The master key `assertion` opens from `backup`. `unverified` when the user was not verified;
 * `version` and `decrypt` from the envelope itself.
 */
export async function openBackupEnvelope(
  assertion: PasskeyAssertResult,
  backup: BackupEnvelope,
): Promise<Fr> {
  if (!userVerified(assertion)) throw new PasskeyEnvelopeError("unverified")
  const masterKey = await openMasterKey({
    envelope: backup.envelope,
    prf: prfOutputsOf(evidenceOf(assertion)),
    account: backup.account,
    credentialId: backup.credentialId,
  })
  return Fr.fromBuffer(Buffer.from(masterKey))
}
