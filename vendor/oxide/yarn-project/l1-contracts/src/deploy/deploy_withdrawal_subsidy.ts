import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';

import { WithdrawalSubsidyAbi, WithdrawalSubsidyBytecode } from '../abis/WithdrawalSubsidy.js';

export async function deployWithdrawalSubsidy(
  client: ExtendedViemWalletClient,
  owner: EthAddress,
  portal: EthAddress,
  executor: EthAddress,
  priceFeed: EthAddress,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(client, WithdrawalSubsidyAbi, WithdrawalSubsidyBytecode, [
    owner.toString(),
    portal.toString(),
    executor.toString(),
    priceFeed.toString(),
  ]);
  return address;
}
