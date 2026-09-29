import type { EthAddress } from '@aztec/foundation/eth-address';

/**
 * Thrown by a `FindFunders` lookup that cannot produce the funder set of a SIPA. The caller must not act on the
 * SIPA: an unknown funder set means the screen did not run, not that the SIPA is clean. The typed error separates
 * this permanent-until-operator-action condition from a transient lookup failure, so callers can alarm on it.
 */
export class UnscreenableSipaError extends Error {
  constructor(
    readonly sipa: EthAddress,
    reason: string,
  ) {
    super(`SIPA ${sipa.toString()} cannot have its funders screened: ${reason}`);
    this.name = 'UnscreenableSipaError';
  }
}
