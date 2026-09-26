/**
 * TEE signer abstraction used by the sandbox portal test stack (note
 * attestation during `registerTeeSigner`).
 *
 * Wraps oxide's `TeeSigner` interface from `@oxide/oxide-lib/types.js` plus the
 * side data we need: the active `PortalContext` (the L1 portal + L2 portal
 * identities the signer is bound to). The underlying `TeeSigner` exposes
 * `publicKey: SecpPublicKey`, `ethAddress: EthAddress`, and `encryptionPublicKey:
 * P256PublicKey` directly — the wallet inherits those rather than re-declaring
 * them.
 *
 * In these tests the implementation is always `LocalTeeSigner`
 * (`@oxide/tee-enclave/signer.js`) — an in-process secp256k1 keypair.
 */

import type { PortalContext, TeeSigner } from "@oxide/oxide-lib/types.js"

export interface ITEESigner extends TeeSigner {
  /** L1 portal + L2 portal identities the signer is currently bound to. */
  readonly portalContext: PortalContext

  /** Return a new signer with the same key material but a different portal context.
   *  Used when the same TEE serves multiple portal deployments. */
  withPortalContext(portalContext: PortalContext): ITEESigner
}
