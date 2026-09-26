import type { Address, PublicClient, WalletClient } from 'viem';

import { MockLegacyDepositPoolAbi, MockLegacyDepositPoolBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/** Stands in for the retired deposit Pool, so a legacy SIPA implementation has a version to pin. */
export function deployMockLegacyDepositPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  rollupVersion: bigint,
): Promise<Address> {
  return deployContract(walletClient, publicClient, MockLegacyDepositPoolAbi, MockLegacyDepositPoolBytecode, [
    rollupVersion,
  ]);
}
