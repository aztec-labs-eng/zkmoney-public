import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import { FleetSigner } from '@oxide/oxide-client/fleet_signer.js';

import type { RunConfig } from '../cli/config.js';
import type { DeploymentEnvManifestPublicConfig } from '../config/deployment_env_manifest.js';
import type { L1SubmissionBatcher } from '../l1_submission_batcher.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils } from '../relayer_l1_tx_utils.js';
import { OxideProverClaimRewardCollector } from './prover_claim/oxide_prover_claim_reward_collector.js';

/**
 * Start the prover-claim collector: it pools the prover tips this prover captured and submits them whenever they
 * cover their own gas.
 *
 * The relayer's signer is the prover. `claimProverTips` credits `msg.sender`, and the Portal pays only the
 * address recorded in `$firstProver`, so the collector can only collect what this same key proved.
 */
export async function startProverClaimCollector(
  config: RunConfig,
  publicConfig: DeploymentEnvManifestPublicConfig,
  l1TxUtils: RelayerL1TxUtils,
  l1SubmissionBatcher: L1SubmissionBatcher,
  priceOracle: ChainlinkPriceOracle,
): Promise<OxideProverClaimRewardCollector> {
  const enclaveUrl = publicConfig.enclaveUrl;
  if (!enclaveUrl) {
    throw new Error('epoch-proofs mode requires enclaveUrl in the deployment env manifest public config.');
  }

  const proverSubsidy = publicConfig.proverSubsidy;

  const proverId = l1TxUtils.getSenderAddress();

  const portalContract = new OxidePortalContract(l1TxUtils.client, publicConfig.portal);
  const teeSigner = await FleetSigner.connect(enclaveUrl, portalContract);

  const collector = await OxideProverClaimRewardCollector.create({
    proverId,
    portalAddress: publicConfig.portal,
    proverSubsidyAddress: proverSubsidy,
    // Share the relayer's queued utils so claim sends take their turn on the one nonce with every other mode.
    l1TxUtils,
    l1SubmissionBatcher,
    nodeUrl: config.aztecNodeUrl,
    nodeApiKey: config.aztecNodeApiKey,
    signer: teeSigner,
    priceOracle,
    log: undefined,
  });

  await collector.start();
  console.log(`prover claim collector is running for prover ${proverId}`);
  return collector;
}
