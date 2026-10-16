import { EthAddress } from '@aztec/foundation/eth-address';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import type { PublicClient } from 'viem';

import type { RunConfig } from '../cli/config.js';
import type { ResolvedDeploymentEnvManifest } from '../config/deployment_env_manifest.js';
import type { L1TxQueue } from '../l1/l1_tx_queue.js';
import type { PriceOracle } from '../price_oracle/price_oracle.js';
import { SimplePriceOracle } from '../price_oracle/simple_price_oracle.js';
import { selectProverPortals } from './portal_selection.js';
import { startEarlyProofStarter } from './start_early_proof_starter.js';
import { startProverClaimCollector } from './start_prover_claim_collector.js';

/** The relayer services that the epoch-proofs mode uses. */
export interface EpochProofsDeps {
  client: PublicClient;
  node: Pick<AztecNode, 'getNodeInfo'>;
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address' | 'maxFeePerGasCap'>;
  /** Finalizes prover claims in place of the enclave fleet the manifest publishes. */
  teeSigner?: TeeSigner;
}

/**
 * Start the epoch-proofs mode: the early proof starter and the prover-claim collector, over the manifest entries that
 * `config.proverPayoutTokens` selects.
 *
 * The mode is temporary. When the Aztec protocol enshrines early epoch proofs, remove this directory and its
 * connection points in `cli/` and `main.ts`.
 */
export async function startEpochProofs(
  config: RunConfig,
  manifest: Pick<ResolvedDeploymentEnvManifest, 'current' | 'historical'>,
  deps: EpochProofsDeps,
): Promise<{ stop(): Promise<void> }> {
  const { client, l1TxQueue, teeSigner } = deps;
  const { rollupVersion } = await deps.node.getNodeInfo();
  const portals = await selectProverPortals(manifest, config.proverPayoutTokens, BigInt(rollupVersion), portal =>
    new OxidePortalContract(client, portal).getUnderlying(),
  );
  for (const { deployment, underlying } of portals) {
    console.log(
      `prover collects from ${deployment.label} portal ${deployment.publicConfig.portal}, paid in ${underlying}`,
    );
  }

  const priceOracle = await createPriceOracle(
    client,
    portals.map(portal => portal.underlying),
  );

  const services: { stop(): Promise<void> }[] = [];
  const stop = async () => {
    await Promise.allSettled(services.map(service => service.stop()));
  };
  try {
    const deployments = portals.map(portal => portal.deployment);
    if (config.proverNodeUrl) {
      services.push(await startEarlyProofStarter(config, deployments, client, priceOracle, l1TxQueue.maxFeePerGasCap));
    }
    services.push(await startProverClaimCollector(config, deployments, client, l1TxQueue, priceOracle, teeSigner));
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}

async function createPriceOracle(client: PublicClient, tokens: EthAddress[]): Promise<PriceOracle> {
  const unique = tokens.filter((token, i) => tokens.findIndex(other => other.equals(token)) === i);
  const oracle = await SimplePriceOracle.create(client, { chainId: BigInt(await client.getChainId()), tokens: unique });
  for (const line of oracle.describe()) {
    console.log(`prover reward pricing: ${line}`);
  }
  return oracle;
}
