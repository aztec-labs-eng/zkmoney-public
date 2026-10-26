import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { ProverSubsidyAbi } from '@oxide/l1-contracts';
import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';

import { FinalizationRequestSource } from '../finalization_request_source.js';
import { EarlySubmitPortalConfig } from '../profitable_partial_epoch_policy/index.js';
import { ProverClaimPortalConfig, ProverClaimPortalContext } from '../prover_claim_lib/index.js';
import { ProverClaimAdaptor, ProverClaimAdaptorDeps, ProverClaimDiscoveryAdaptor } from './adaptor.js';

export interface CreatePortalConfigOptions {
  portal: OxidePortalContract;
  proverSubsidy: EthAddress;
  /** Node that serves the initiation txs that carry the finalization requests. */
  node: ProverClaimAdaptorDeps['node'];
  /** The Broadcaster that the finalization requests come through. */
  broadcaster: AztecAddress;
}

async function buildContext(
  options: Pick<CreatePortalConfigOptions, 'portal' | 'proverSubsidy'>,
): Promise<ProverClaimPortalContext> {
  const [l2Token, token] = await Promise.all([options.portal.getL2Token(), options.portal.getUnderlying()]);
  return { l1Portal: options.portal.address, l2Token, token, proverSubsidy: options.proverSubsidy };
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
    adaptor: await ProverClaimDiscoveryAdaptor.create({
      portal: options.portal,
      requestSource: new FinalizationRequestSource(
        options.node,
        await options.portal.getPortalDomain(),
        options.broadcaster,
      ),
    }),
    quoteProverSubsidy: numClaims =>
      client.readContract({ ...proverSubsidy, functionName: 'quoteSubsidy', args: [numClaims] }),
  };
}

/** Config for the claim collector: its adaptor can also assemble claims for submission. */
export async function createClaimPortalConfig(
  options: Pick<CreatePortalConfigOptions, 'portal' | 'proverSubsidy'> & { adaptorDeps: ProverClaimAdaptorDeps },
): Promise<ProverClaimPortalConfig & { adaptor: ProverClaimAdaptor }> {
  return {
    context: await buildContext(options),
    adaptor: await ProverClaimAdaptor.create(options.adaptorDeps),
    contract: options.portal,
  };
}
