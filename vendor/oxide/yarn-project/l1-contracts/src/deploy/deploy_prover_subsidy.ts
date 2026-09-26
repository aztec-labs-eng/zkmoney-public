import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { ProverSubsidyAbi, ProverSubsidyBytecode } from '../abis/ProverSubsidy.js';

export async function deployProverSubsidy(
  client: ExtendedViemWalletClient,
  owner: EthAddress,
  portal: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, ProverSubsidyAbi, ProverSubsidyBytecode, [
    owner.toString(),
    portal.toString(),
  ]);
  return address;
}
