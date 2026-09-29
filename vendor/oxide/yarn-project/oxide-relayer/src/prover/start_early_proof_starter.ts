import type { L1TxUtils } from '@aztec/ethereum/l1-tx-utils';

import type { RunConfig } from '../cli/config.js';
import type { DeploymentEnvManifestPublicConfig } from '../config/deployment_env_manifest.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import { ProfitablePartialEpochProofStarter } from './prover_claim/profitable_partial_epoch_proof_starter.js';

/**
 * Start the proof starter: it watches checkpoints and asks the prover node to prove the current epoch prefix
 * whenever the withdrawal prover tips make proving it profitable. Runs until the returned starter is stopped.
 */
export async function startEarlyProofStarter(
  config: RunConfig,
  publicConfig: DeploymentEnvManifestPublicConfig,
  l1TxUtils: L1TxUtils,
  priceOracle: ChainlinkPriceOracle,
): Promise<ProfitablePartialEpochProofStarter> {
  if (!config.proverNodeUrl) {
    throw new Error('early proof starter requires --prover-node-url or OXIDE_RELAYER_PROVER_NODE_URL.');
  }

  const proverSubsidy = publicConfig.proverSubsidy;

  const starter = await ProfitablePartialEpochProofStarter.create({
    nodeUrl: config.aztecNodeUrl,
    nodeApiKey: config.aztecNodeApiKey,
    proverNodeUrl: config.proverNodeUrl,
    l1Client: l1TxUtils.client,
    portalAddress: publicConfig.portal,
    proverSubsidyAddress: proverSubsidy,
    rewardRecipient: l1TxUtils.getSenderAddress(),
    priceOracle,
    earlySubmitPolicy: config.earlyProofPolicy,
    onError: error => {
      console.error(`early proof starter error: ${error}`);
    },
  });

  await starter.start();
  console.log('early proof starter is running');
  return starter;
}
