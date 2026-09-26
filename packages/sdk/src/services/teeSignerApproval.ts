/**
 * Wallet-side gate on the OxideToken's `approved_signers` map. Nothing on chain rejects a transfer
 * signed by an enclave the token has not approved: the notes mine, then every recipient's PXE
 * drops them in `validate_note` and the balance silently reads 0. The L1 portal binding a
 * `FleetSigner` verifies at connect time is not this approval, so the wallet checks the L2 map
 * itself, on the key that actually signed, before any tx is assembled.
 *
 * Consumes `fetchSignerApprovalWitness` from oxide-client; the slot derivation is not copied.
 */

import type { AztecNode } from "@aztec/aztec.js/node"
import type { EthAddress } from "@aztec/foundation/eth-address"
import { createLogger } from "@aztec/foundation/log"
import type { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { BlockHash } from "@aztec/stdlib/block"
import { fetchSignerApprovalWitness } from "@oxide/oxide-client/signer_approval.js"
import { ethAddressFromSecpPublicKey } from "@oxide/oxide-lib/attestation/user_data.js"
import { computeSignerApprovalLeafSlot } from "@oxide/oxide-lib/hash.js"
import type { SecpPublicKey, TeeSigner } from "@oxide/oxide-lib/types.js"

const logger = createLogger("sdk:tee-signer-approval")

/** The signing enclave is registered on L1 but not approved on the token, so its notes would be dropped. */
export class TeeSignerNotApprovedError extends Error {
  constructor(
    readonly tokenAddress: AztecAddress,
    readonly enclaveAddress: EthAddress,
    /** secp256k1 x coordinate of the signing key, hex. */
    readonly publicKeyX: string,
  ) {
    super(
      `Signing enclave ${enclaveAddress.toString()} is not approved on token ${tokenAddress.toString()}; refusing to sign with it.`,
    )
    this.name = "TeeSignerNotApprovedError"
  }
}

export interface AssertTeeSignerApprovedArgs {
  node: Pick<AztecNode, "getPublicDataWitness">
  tokenAddress: AztecAddress
  /** The key that signed (or will sign), read from the signer once. */
  publicKey: SecpPublicKey
  /** Block the approval is read at: the operation anchor at sign time, `latest` at connect time. */
  blockHash: BlockHash
}

/**
 * Resolves when `publicKey` is approved on `tokenAddress` at `blockHash`. Approved means the
 * witness leaf is the key's own slot and holds 1; a low leaf (slot never written) or a 0 value
 * throws {@link TeeSignerNotApprovedError}. A missing witness (unknown block) propagates raw.
 */
export async function assertTeeSignerApproved(args: AssertTeeSignerApprovedArgs): Promise<void> {
  const { node, tokenAddress, publicKey, blockHash } = args
  const [leafSlot, witness] = await Promise.all([
    computeSignerApprovalLeafSlot(tokenAddress, publicKey),
    fetchSignerApprovalWitness(node, tokenAddress, publicKey, blockHash),
  ])
  const leaf = witness.leafPreimage.leaf
  if (leaf.slot.equals(leafSlot) && leaf.value.toBigInt() === 1n) return

  const enclaveAddress = ethAddressFromSecpPublicKey(publicKey)
  const publicKeyX = publicKey.x.toString()
  logger.warn("refusing TEE signer: not approved on token", {
    token: tokenAddress.toString(),
    enclave: enclaveAddress.toString(),
    publicKeyX,
    block: blockHash.toString(),
  })
  throw new TeeSignerNotApprovedError(tokenAddress, enclaveAddress, publicKeyX)
}

/** Told which connected signer a finalizer refused; its owner drops it and selects an enclave again. */
export type TeeSignerRefusedListener = (signer: TeeSigner, error: TeeSignerNotApprovedError) => void

const refusedListeners = new Set<TeeSignerRefusedListener>()

export function onTeeSignerRefused(listener: TeeSignerRefusedListener): () => void {
  refusedListeners.add(listener)
  return () => {
    refusedListeners.delete(listener)
  }
}

/** A listener that throws is logged and skipped: observers never alter the refusal or starve each other. */
export function reportTeeSignerRefused(signer: TeeSigner, error: TeeSignerNotApprovedError): void {
  for (const listener of refusedListeners) {
    try {
      listener(signer, error)
    } catch (listenerError) {
      logger.error("TEE signer refusal listener threw", listenerError)
    }
  }
}

export interface AssertSigningKeyApprovedArgs
  extends Omit<AssertTeeSignerApprovedArgs, "publicKey"> {
  /** The signer that just signed; its key is read once here. */
  signer: TeeSigner
}

/**
 * The sign-time gate. `signTokenOperation` can re-pin `signer` to another enclave, so the key is
 * read once, after signing, and checked at the operation anchor; the caller builds its TEE metadata
 * from the returned key. A refusal reaches {@link onTeeSignerRefused} listeners before it is thrown:
 * the connect-time check already accepted this signer, so only its owner can recover.
 */
export async function assertSigningKeyApproved(
  args: AssertSigningKeyApprovedArgs,
): Promise<SecpPublicKey> {
  const { signer, ...rest } = args
  const publicKey = signer.publicKey
  try {
    await assertTeeSignerApproved({ ...rest, publicKey })
  } catch (err) {
    if (err instanceof TeeSignerNotApprovedError) reportTeeSignerRefused(signer, err)
    throw err
  }
  return publicKey
}
