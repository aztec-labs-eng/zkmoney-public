import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { DepositSubsidyAbi, DepositSubsidyBytecode } from '../abis/DepositSubsidy.js';

/** `portal` is the version's Portal the deposit subsidy sweeps SIPAs into. `sipaFactory` is the environment's
 *  permanent factory: the deposit subsidy asks it, and only it, whether the SIPA it is about to sweep for is blessed.
 *  It is passed explicitly because the deposit subsidy does not read it off the portal. */
export async function deployDepositSubsidy(
  client: ExtendedViemWalletClient,
  owner: EthAddress,
  portal: EthAddress,
  priceFeed: EthAddress,
  sipaFactory: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, DepositSubsidyAbi, DepositSubsidyBytecode, [
    owner.toString(),
    portal.toString(),
    priceFeed.toString(),
    sipaFactory.toString(),
  ]);
  return address;
}
