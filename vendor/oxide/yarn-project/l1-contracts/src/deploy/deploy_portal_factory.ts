import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { PortalFactoryAbi, PortalFactoryBytecode } from '../artifacts.js';
import { PortalFactoryContract } from '../portal_factory.js';

/**
 * The oxide refund proof verifiers that the PortalFactory constructor takes and gives to each portal.
 */
export interface PortalRefundVerifiers {
  frozenNotes: EthAddress;
  frozenDeposits: EthAddress;
  unprocessedDeposit: EthAddress;
}

export type DeployPortalFactoryArgs = {
  /** The only account that can call `deployPortal`. */
  owner: EthAddress;
  teeRegistry: EthAddress;
  /** Aztec registry; each portal resolves the rollup (and its inbox/outbox) from it by version. */
  registry: EthAddress;
  rollupVersion: bigint;
  verifiers: PortalRefundVerifiers;
};

export async function deployPortalFactory(
  client: ExtendedViemWalletClient,
  args: DeployPortalFactoryArgs,
): Promise<PortalFactoryContract> {
  const { address } = await deployL1Contract(client, PortalFactoryAbi, PortalFactoryBytecode, [
    args.owner.toString(),
    args.teeRegistry.toString(),
    args.registry.toString(),
    args.rollupVersion,
    {
      frozenNotes: args.verifiers.frozenNotes.toString(),
      frozenDeposits: args.verifiers.frozenDeposits.toString(),
      unprocessedDeposit: args.verifiers.unprocessedDeposit.toString(),
    },
  ]);
  return new PortalFactoryContract(client, address);
}
