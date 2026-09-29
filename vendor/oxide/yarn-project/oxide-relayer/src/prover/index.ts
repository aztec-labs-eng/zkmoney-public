import type { RunConfig } from '../cli/config.js';
import type { ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';
import type { L1SubmissionBatcher } from '../l1_submission_batcher.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils } from '../relayer_l1_tx_utils.js';
import { startEarlyProofStarter } from './start_early_proof_starter.js';
import { startProverClaimCollector } from './start_prover_claim_collector.js';

/** The relayer services that the epoch-proofs mode uses. The submission services are unset when submission is off. */
export interface EpochProofsDeps {
  l1TxUtils?: RelayerL1TxUtils;
  l1SubmissionBatcher?: L1SubmissionBatcher;
  priceOracle: ChainlinkPriceOracle;
}

/**
 * Start the epoch-proofs mode for the pinned deployment: the early proof starter and the prover-claim collector.
 *
 * The mode is temporary. When the Aztec protocol enshrines early epoch proofs, remove this directory and its
 * connection points in `cli/` and `main.ts`.
 */
export async function startEpochProofs(
  config: RunConfig,
  deployment: ResolvedManifestDeployment,
  deps: EpochProofsDeps,
): Promise<{ stop(): Promise<void> }> {
  const { l1TxUtils, l1SubmissionBatcher, priceOracle } = deps;
  if (!l1TxUtils || !l1SubmissionBatcher) {
    console.log(
      'epoch-proofs mode is enabled but submission is disabled; early proof starter and claim collector will not start.',
    );
    return { stop: () => Promise.resolve() };
  }
  assertProverSubsidyPublished(deployment);

  const services: { stop(): Promise<void> }[] = [];
  const stop = async () => {
    await Promise.allSettled(services.map(service => service.stop()));
  };
  try {
    if (config.proverNodeUrl) {
      services.push(await startEarlyProofStarter(config, deployment.publicConfig, l1TxUtils, priceOracle));
    }
    services.push(
      await startProverClaimCollector(config, deployment.publicConfig, l1TxUtils, l1SubmissionBatcher, priceOracle),
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}

// This is a bit messed up as it enforces this now only when epoch proof mode is enabled as in the withdrawals mode
// the withdrawal subsidy is now encoded directly in the user supplied calldata. This will get purged soon.
function assertProverSubsidyPublished(current: ResolvedManifestDeployment): void {
  if (current.publicConfig.proverSubsidy.isZero()) {
    throw new Error(
      `deployment ${current.publicConfig.portal} (${current.label}) publishes the zero address for proverSubsidy.`,
    );
  }
}
