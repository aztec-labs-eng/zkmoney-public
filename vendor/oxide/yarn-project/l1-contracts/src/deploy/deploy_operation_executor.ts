import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { OperationExecutorAbi, OperationExecutorBytecode } from '../abis/OperationExecutor.js';

export async function deployOperationExecutor(client: ExtendedViemWalletClient): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, OperationExecutorAbi, OperationExecutorBytecode, []);
  return address;
}
