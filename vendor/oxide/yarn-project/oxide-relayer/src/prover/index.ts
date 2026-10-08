import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import type { PublicClient } from 'viem';

import type { RunConfig } from '../cli/config.js';
import type { ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';
import type { L1TxQueue } from '../l1/l1_tx_queue.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import { startEarlyProofStarter } from './start_early_proof_starter.js';
import { startProverClaimCollector } from './start_prover_claim_collector.js';

/** The relayer services that the epoch-proofs mode uses. */
export interface EpochProofsDeps {
  client: PublicClient;
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address' | 'maxFeePerGasCap'>;
  priceOracle: ChainlinkPriceOracle;
  /** Finalizes prover claims in place of the enclave fleet the manifest publishes. */
  teeSigner?: TeeSigner;
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
  const { client, l1TxQueue, priceOracle, teeSigner } = deps;
  assertProverSubsidyPublished(deployment);

  const services: { stop(): Promise<void> }[] = [];
  const stop = async () => {
    await Promise.allSettled(services.map(service => service.stop()));
  };
  try {
    if (config.proverNodeUrl) {
      services.push(await startEarlyProofStarter(config, deployment.publicConfig, client, priceOracle));
    }
    services.push(
      await startProverClaimCollector(config, deployment.publicConfig, client, l1TxQueue, priceOracle, teeSigner),
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
