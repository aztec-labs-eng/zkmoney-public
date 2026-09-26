/**
 * Narrow registry-check interface consumed by ZkJwtService to validate a
 * cached proof against the on-chain OIDC registry allowlists before reuse.
 *
 * Implementations return `true`/`false` for allowlist status, or throw on
 * transient failure (e.g. RPC error). The service treats thrown errors as
 * invalid-but-retain — the cached bundle stays for a later retry.
 *
 * The sdk's `OidcKeyRegistryService` implements this structurally; tests can
 * supply any object with the same two methods.
 */
export interface IZkJwtRegistryCheck {
  isValidJwk(jwkId: string, issHash: string): Promise<boolean>
  isAudAllowed(audHash: string): Promise<boolean>
}
