import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import { OperationExecutorAbi, OperationExecutorBytecode } from '../abis/OperationExecutor.js';

export async function deployOperationExecutor(client: ExtendedViemWalletClient): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, OperationExecutorAbi, OperationExecutorBytecode, []);
  return address;
}
