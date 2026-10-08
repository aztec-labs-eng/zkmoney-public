import { EthAddress } from '@aztec/foundation/eth-address';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import { FleetSigner } from '@oxide/oxide-client/fleet_signer.js';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import type { PublicClient } from 'viem';

import type { RunConfig } from '../cli/config.js';
import type { DeploymentEnvManifestPublicConfig } from '../config/deployment_env_manifest.js';
import type { L1TxQueue } from '../l1/l1_tx_queue.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import { OxideProverClaimRewardCollector } from './prover_claim/oxide_prover_claim_reward_collector.js';

/**
 * Start the prover-claim collector: it pools the prover tips this prover captured and submits them whenever they
 * cover their own gas.
 *
 * The relayer's signer is the prover. `claimProverTips` credits `msg.sender`, and the Portal pays only the
 * address recorded in `$firstProver`, so the collector can only collect what this same key proved.
 *
 * Claims are finalized by `teeSigner` when one is given, else by the enclave fleet the manifest publishes.
 */
export async function startProverClaimCollector(
  config: RunConfig,
  publicConfig: DeploymentEnvManifestPublicConfig,
  client: PublicClient,
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address' | 'maxFeePerGasCap'>,
  priceOracle: ChainlinkPriceOracle,
  teeSigner?: TeeSigner,
): Promise<OxideProverClaimRewardCollector> {
  const enclaveUrl = publicConfig.enclaveUrl;
  if (!teeSigner && !enclaveUrl) {
    throw new Error('epoch-proofs mode requires enclaveUrl in the deployment env manifest public config.');
  }

  const proverSubsidy = publicConfig.proverSubsidy;

  const proverId = EthAddress.fromString(l1TxQueue.address);

  const portalContract = new OxidePortalContract(client, publicConfig.portal);
  const signer = teeSigner ?? (await FleetSigner.connect(enclaveUrl, portalContract));

  const collector = await OxideProverClaimRewardCollector.create({
    proverId,
    portalAddress: publicConfig.portal,
    proverSubsidyAddress: proverSubsidy,
    client,
    // Share the relayer's L1 tx queue so claim sends take their turn on the one nonce with every other mode.
    l1TxQueue,
    nodeUrl: config.aztecNodeUrl,
    nodeApiKey: config.aztecNodeApiKey,
    signer,
    priceOracle,
    log: undefined,
  });

  await collector.start();
  console.log(`prover claim collector is running for prover ${proverId}`);
  return collector;
}
