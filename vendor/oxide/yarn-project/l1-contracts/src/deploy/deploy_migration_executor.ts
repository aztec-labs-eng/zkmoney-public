import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import type { Hex } from 'viem';

import { MigrationExecutorAbi, MigrationExecutorBytecode } from '../abis/MigrationExecutor.js';

export interface DeployMigrationExecutorArgs {
  /** The old portal. Its refunds and withdrawals name the executor. */
  sourcePortal: EthAddress;
  /** The new portal of the same underlying. The executor deposits the migrated amount into it. */
  destinationPortal: EthAddress;
  /** The token that the migration subsidy pays the relayer in (`TOKEN`). */
  payoutToken: EthAddress;
  /** The owner of the migration subsidy. It sets the config and can defund the subsidy. */
  subsidyOwner: EthAddress;
  /** The code hash of the `OperationExecutor` that the subsidy accepts as its caller. */
  operationExecutorCodeHash: Hex;
  /** The ETH/USD price feed that the subsidy prices the gas with. */
  priceFeed: EthAddress;
}

/**
 * Deploys the migration executor and returns it with the migration subsidy that its constructor creates. The subsidy
 * starts with a zero config and no balance, so it pays nothing until its owner sets the config and funds it.
 */
export async function deployMigrationExecutor(
  client: ExtendedViemWalletClient,
  args: DeployMigrationExecutorArgs,
): Promise<{ executor: EthAddress; subsidy: EthAddress }> {
  const { address } = await deployL1Contract(client, MigrationExecutorAbi, MigrationExecutorBytecode, [
    args.sourcePortal.toString(),
    args.destinationPortal.toString(),
    args.payoutToken.toString(),
    args.subsidyOwner.toString(),
    args.operationExecutorCodeHash,
    args.priceFeed.toString(),
  ]);
  const subsidy = await client.readContract({
    address: address.toString(),
    abi: MigrationExecutorAbi,
    functionName: 'SUBSIDY',
  });
  return { executor: address, subsidy: EthAddress.fromString(subsidy) };
}
