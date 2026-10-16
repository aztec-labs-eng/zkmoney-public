import type { EthAddress } from '@aztec/foundation/eth-address';

import type { ResolvedDeploymentEnvManifest, ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';

/** A manifest entry that the prover collects from, and the token that its portal pays tips in. */
export interface ProverPortal {
  deployment: ResolvedManifestDeployment;
  /** The portal's underlying, read on chain. Prover tips and the prover subsidy are paid in it. */
  underlying: EthAddress;
}

/**
 * Select the manifest entries that the prover collects from.
 *
 * - When `payoutTokens` is unset, select the pinned entry only.
 * - When `payoutTokens` is set, select each entry whose portal pays in one of them. The pinned entry comes first when
 *   it is selected.
 *
 * Every historical entry has the `rollupVersion` of the pinned entry, and the registry keeps one rollup for each
 * version, so all entries are on the rollup of the pinned entry. That must be the rollup that the prover proves.
 *
 * Throws when the pinned entry is not on `rollupVersion`, when no entry is selected, or when a selected entry
 * publishes the zero address for `proverSubsidy`.
 */
export async function selectProverPortals(
  manifest: Pick<ResolvedDeploymentEnvManifest, 'current' | 'historical'>,
  payoutTokens: EthAddress[] | undefined,
  rollupVersion: bigint,
  readUnderlying: (portal: EthAddress) => Promise<EthAddress>,
): Promise<ProverPortal[]> {
  const { current } = manifest;
  if (current.publicConfig.rollupVersion !== rollupVersion) {
    throw new Error(
      `deployment ${current.publicConfig.portal} (${current.label}) is on rollup version ` +
        `${current.publicConfig.rollupVersion}, not on rollup version ${rollupVersion} that the prover proves.`,
    );
  }

  const candidates = payoutTokens === undefined ? [current] : [current, ...manifest.historical];
  const withUnderlying = await Promise.all(
    candidates.map(async deployment => ({
      deployment,
      underlying: await readUnderlying(deployment.publicConfig.portal),
    })),
  );
  const selected =
    payoutTokens === undefined
      ? withUnderlying
      : withUnderlying.filter(({ underlying }) => payoutTokens.some(token => token.equals(underlying)));
  if (selected.length === 0) {
    throw new Error(
      `no deployment of rollup version ${rollupVersion} has a portal that pays in one of the prover payout tokens ` +
        `${payoutTokens!.join(', ')}.`,
    );
  }
  selected.forEach(({ deployment }) => assertProverSubsidyPublished(deployment));
  return selected;
}

// The portal requires a nonzero prover subsidy. Without it, the prover cannot collect rewards from the portal.
function assertProverSubsidyPublished(deployment: ResolvedManifestDeployment): void {
  if (deployment.publicConfig.proverSubsidy.isZero()) {
    throw new Error(
      `deployment ${deployment.publicConfig.portal} (${deployment.label}) publishes the zero address for proverSubsidy.`,
    );
  }
}
