import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import { DepositSubsidyAbi, DepositSubsidyBytecode } from '../abis/DepositSubsidy.js';

/** `portal` is the version's Portal the deposit subsidy sweeps SIPAs into. `operationExecutor` is the executor that
 *  the relayer sends through: a sweep that a relayer sends from an EOA through it is paid its whole transaction gas,
 *  and any other caller gets no subsidy. `sipaFactory` is the environment's permanent factory: the deposit subsidy
 *  asks it, and only it, whether the SIPA it is about to sweep for is blessed. It is passed explicitly because the
 *  deposit subsidy does not read it off the portal. */
export async function deployDepositSubsidy(
  client: ExtendedViemWalletClient,
  owner: EthAddress,
  portal: EthAddress,
  operationExecutor: EthAddress,
  priceFeed: EthAddress,
  sipaFactory: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, DepositSubsidyAbi, DepositSubsidyBytecode, [
    owner.toString(),
    portal.toString(),
    operationExecutor.toString(),
    priceFeed.toString(),
    sipaFactory.toString(),
  ]);
  return address;
}
