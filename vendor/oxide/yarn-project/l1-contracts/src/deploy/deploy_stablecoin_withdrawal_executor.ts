import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  StablecoinWithdrawalExecutorAbi,
  StablecoinWithdrawalExecutorBytecode,
} from '../abis/StablecoinWithdrawalExecutor.js';

/** Deploys the executor and returns it with the withdrawal subsidy that its constructor creates. */
export async function deployStablecoinWithdrawalExecutor(
  client: ExtendedViemWalletClient,
  portal: EthAddress,
  fee: bigint,
  feeBeneficiary: EthAddress,
  subsidyOwner: EthAddress,
  priceFeed: EthAddress,
): Promise<{ executor: EthAddress; withdrawalSubsidy: EthAddress }> {
  const { address } = await deployL1Contract(
    client,
    StablecoinWithdrawalExecutorAbi,
    StablecoinWithdrawalExecutorBytecode,
    [portal.toString(), fee, feeBeneficiary.toString(), subsidyOwner.toString(), priceFeed.toString()],
  );
  const withdrawalSubsidy = await client.readContract({
    address: address.toString(),
    abi: StablecoinWithdrawalExecutorAbi,
    functionName: 'SUBSIDY',
  });
  return { executor: address, withdrawalSubsidy: EthAddress.fromString(withdrawalSubsidy) };
}
