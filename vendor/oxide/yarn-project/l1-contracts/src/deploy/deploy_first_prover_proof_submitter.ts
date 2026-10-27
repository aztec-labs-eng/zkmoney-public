import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import { FirstProverProofSubmitterAbi, FirstProverProofSubmitterBytecode } from '../abis/FirstProverProofSubmitter.js';

export async function deployFirstProverProofSubmitter(
  client: ExtendedViemWalletClient,
  rollup: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, FirstProverProofSubmitterAbi, FirstProverProofSubmitterBytecode, [
    rollup.toString(),
  ]);
  return address;
}
