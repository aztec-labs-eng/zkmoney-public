import { EthAddress } from '@aztec/foundation/eth-address';

import { ProverSubsidyAbi } from '@oxide/l1-contracts';
import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';

import { EarlySubmitPortalConfig } from '../profitable_partial_epoch_policy/index.js';
import { ProverClaimPortalConfig, ProverClaimPortalContext } from '../prover_claim_lib/index.js';
import { ProverClaimAdaptor, ProverClaimAdaptorDeps, ProverClaimDiscoveryAdaptor } from './adaptor.js';

export interface CreatePortalConfigOptions {
  portal: OxidePortalContract;
  proverSubsidy: EthAddress;
}

async function buildContext(options: CreatePortalConfigOptions): Promise<ProverClaimPortalContext> {
  const [l2Portal, token] = await Promise.all([options.portal.getL2Portal(), options.portal.getUnderlying()]);
  return { l1Portal: options.portal.address, l2Portal, token, proverSubsidy: options.proverSubsidy };
}

/** Discovery config for the early-submit policy, with the subsidy quoted by the deployed ProverSubsidy. */
export async function createPortalConfig(
  options: CreatePortalConfigOptions,
): Promise<EarlySubmitPortalConfig & { adaptor: ProverClaimDiscoveryAdaptor }> {
  const client = options.portal.client;
  const proverSubsidy = { address: options.proverSubsidy.toString(), abi: ProverSubsidyAbi } as const;

  const boundPortal = EthAddress.fromString(await client.readContract({ ...proverSubsidy, functionName: 'PORTAL' }));
  if (!boundPortal.equals(options.portal.address)) {
    throw new Error(
      `Prover subsidy ${options.proverSubsidy} is pinned to portal ${boundPortal}, not ${options.portal.address}`,
    );
  }
  return {
    context: await buildContext(options),
    adaptor: await ProverClaimDiscoveryAdaptor.create(options),
    quoteProverSubsidy: numClaims =>
      client.readContract({ ...proverSubsidy, functionName: 'quoteSubsidy', args: [numClaims] }),
  };
}

/** Config for the claim collector: its adaptor can also assemble claims for submission. */
export async function createClaimPortalConfig(
  options: CreatePortalConfigOptions & { adaptorDeps: ProverClaimAdaptorDeps },
): Promise<ProverClaimPortalConfig & { adaptor: ProverClaimAdaptor }> {
  return {
    context: await buildContext(options),
    adaptor: await ProverClaimAdaptor.create(options.adaptorDeps),
  };
}
