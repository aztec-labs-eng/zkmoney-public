import { Buffer32 } from '@aztec/foundation/buffer';
import { keccak256 } from '@aztec/foundation/crypto/keccak';

import { parseCoseSign1, parseNitroPayload } from './nitro_attestation/parsers.js';

/** One staging call to make against the portal before invoking `registerTee`. Use with
 *  `verifyTeeCACert` for `CertStagingEntries.ca` entries and `verifyTeeClientCert` for
 *  `CertStagingEntries.client`. */
export interface CertStagingEntry {
  /** DER-encoded certificate. */
  cert: Buffer;
  /** `keccak256` of the parent cert in the chain. The parent must already be in the cert manager
   *  — either pre-pinned (the root) or staged by an earlier `verifyTeeCACert` call. */
  parentCertHash: Buffer32;
  /** `keccak256(cert)` — this cert's key in the cert manager's verified cache. */
  certHash: Buffer32;
}

/** Result of {@link getCertStagingEntries}. Caller stages `ca` in order with `verifyTeeCACert`,
 *  then stages `client` with `verifyTeeClientCert` — both must complete before `registerTee`. */
export interface CertStagingEntries {
  /** Cabundle intermediates (root excluded — it's pre-pinned in the cert manager). Stage these
   *  in order with `verifyTeeCACert`; each `parentCertHash` is `keccak256(previous entry)`, or
   *  `keccak256(root)` for the first. */
  ca: CertStagingEntry[];
  /** Per-attestation enclave leaf cert. Stage with `verifyTeeClientCert` AFTER all `ca` entries
   *  — its `parentCertHash` is `keccak256(last cabundle entry)`, so the last intermediate must
   *  be in the cert manager first or the call will revert with `parent cert unverified`. */
  client: CertStagingEntry;
  /** `keccak256(client.cert)` — pass to `portal.verifyTeeAttestationSig` to bind the staged COSE
   *  signature to this specific leaf. Same value `verifyTeeClientCert` returns on-chain. */
  leafCertHash: Buffer32;
}

/**
 * Extract every cert that needs to be staged in the cert manager before `registerTee` will fit
 * under a sane gas budget. Returns the cabundle intermediates separately from the per-attestation
 * leaf so callers can dispatch each to the matching portal entry point:
 *
 *   - `ca[]`     — cabundle intermediates in chain order (root skipped, pre-pinned),
 *                  each staged via `verifyTeeCACert`,
 *   - `client`   — the leaf cert (`payload.certificate`), staged via `verifyTeeClientCert`.
 *
 * Staging the client entry caches the leaf's P-384 verify (~9M gas) outside the final
 * `registerTee`; without it the leaf is re-verified inline and `registerTee` blows past most
 * per-tx gas budgets.
 *
 * ```ts
 * const { ca, client } = getCertStagingEntries(attestation);
 * for (const { cert, parentCertHash } of ca) {
 *   await portal.verifyTeeCACert(cert, parentCertHash, { waitForReceipt: true });
 * }
 * await portal.verifyTeeClientCert(client.cert, client.parentCertHash, { waitForReceipt: true });
 * ```
 */
export function getCertStagingEntries(attestation: Buffer): CertStagingEntries {
  const { payloadBytes } = parseCoseSign1(attestation);
  const { caBundle, certificate: leafCert } = parseNitroPayload(payloadBytes);
  if (caBundle.length === 0) {
    throw new Error('Nitro cabundle is empty — expected at least the trusted root cert');
  }
  const ca: CertStagingEntry[] = [];
  for (let i = 1; i < caBundle.length; i++) {
    ca.push({
      cert: caBundle[i],
      parentCertHash: Buffer32.fromBuffer(keccak256(caBundle[i - 1])),
      certHash: Buffer32.fromBuffer(keccak256(caBundle[i])),
    });
  }
  const leafCertHash = Buffer32.fromBuffer(keccak256(leafCert));
  const client: CertStagingEntry = {
    cert: leafCert,
    parentCertHash: Buffer32.fromBuffer(keccak256(caBundle[caBundle.length - 1])),
    certHash: leafCertHash,
  };
  return { ca, client, leafCertHash };
}
