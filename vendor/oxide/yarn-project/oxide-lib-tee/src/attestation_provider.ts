/**
 * Pluggable source of raw COSE_Sign1 attestation documents. The enclave runtime calls `attest()`
 * once at boot with the user_data hash; concrete implementations (NSM in production, synthetic CA
 * chain in local dev) live in their respective entry-point packages so the production EIF doesn't
 * ship the local-dev cert-chain code.
 */
export interface AttestationProvider {
  /** Returns a raw COSE_Sign1 attestation document with the given user_data baked in. */
  attest(userData: Buffer): Promise<Buffer>;
}
