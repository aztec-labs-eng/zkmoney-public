import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { PlainWithdrawalExecutorAbi, PlainWithdrawalExecutorBytecode } from '../abis/PlainWithdrawalExecutor.js';

export async function deployPlainWithdrawalExecutor(
  client: ExtendedViemWalletClient,
  portal: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, PlainWithdrawalExecutorAbi, PlainWithdrawalExecutorBytecode, [
    portal.toString(),
  ]);
  return address;
}
