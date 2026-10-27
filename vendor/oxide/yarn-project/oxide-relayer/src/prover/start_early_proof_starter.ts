import type { PublicClient } from 'viem';

import type { RunConfig } from '../cli/config.js';
import type { ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';
import type { PriceOracle } from '../price_oracle/price_oracle.js';
import { ProfitablePartialEpochProofStarter } from './prover_claim/profitable_partial_epoch_proof_starter.js';

/**
 * Start the proof starter: it watches checkpoints and asks the prover node to prove the current epoch prefix
 * whenever the withdrawal prover tips make proving it profitable. Runs until the returned starter is stopped.
 */
export async function startEarlyProofStarter(
  config: RunConfig,
  deployments: ResolvedManifestDeployment[],
  client: PublicClient,
  priceOracle: PriceOracle,
  maxFeePerGasCap: bigint | undefined,
): Promise<ProfitablePartialEpochProofStarter> {
  if (!config.proverNodeUrl) {
    throw new Error('early proof starter requires --prover-node-url or OXIDE_RELAYER_PROVER_NODE_URL.');
  }

  const starter = await ProfitablePartialEpochProofStarter.create({
    nodeUrl: config.aztecNodeUrl,
    nodeApiKey: config.aztecNodeApiKey,
    proverNodeUrl: config.proverNodeUrl,
    proverNodeApiKey: config.proverNodeApiKey,
    l1Client: client,
    portals: deployments.map(({ publicConfig }) => ({
      portalAddress: publicConfig.portal,
      proverSubsidyAddress: publicConfig.proverSubsidy,
      broadcasterAddress: publicConfig.broadcaster,
    })),
    priceOracle,
    earlySubmitPolicy: config.earlyProofPolicy,
    maxFeePerGasCap,
    onError: error => {
      console.error(`early proof starter error: ${error}`);
    },
  });

  await starter.start();
  console.log('early proof starter is running');
  return starter;
}
