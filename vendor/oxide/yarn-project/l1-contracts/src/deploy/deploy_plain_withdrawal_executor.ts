import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { PlainWithdrawalExecutorAbi, PlainWithdrawalExecutorBytecode } from '../abis/PlainWithdrawalExecutor.js';

/** Deploys the executor and returns it with the withdrawal subsidy that its constructor creates. */
export async function deployPlainWithdrawalExecutor(
  client: ExtendedViemWalletClient,
  portal: EthAddress,
  fee: bigint,
  feeBeneficiary: EthAddress,
  subsidyOwner: EthAddress,
  priceFeed: EthAddress,
): Promise<{ executor: EthAddress; withdrawalSubsidy: EthAddress }> {
  const { address } = await deployL1Contract(client, PlainWithdrawalExecutorAbi, PlainWithdrawalExecutorBytecode, [
    portal.toString(),
    fee,
    feeBeneficiary.toString(),
    subsidyOwner.toString(),
    priceFeed.toString(),
  ]);
  const withdrawalSubsidy = await client.readContract({
    address: address.toString(),
    abi: PlainWithdrawalExecutorAbi,
    functionName: 'SUBSIDY',
  });
  return { executor: address, withdrawalSubsidy: EthAddress.fromString(withdrawalSubsidy) };
}
