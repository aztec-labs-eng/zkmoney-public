import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { FirstProverProofSubmitterAbi, FirstProverProofSubmitterBytecode } from '../abis/FirstProverProofSubmitter.js';

export async function deployFirstProverProofSubmitter(
  client: ExtendedViemWalletClient,
  rollup: EthAddress,
  portal: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, FirstProverProofSubmitterAbi, FirstProverProofSubmitterBytecode, [
    rollup.toString(),
    portal.toString(),
  ]);
  return address;
}
