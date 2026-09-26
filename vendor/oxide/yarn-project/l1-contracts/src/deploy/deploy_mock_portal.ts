import type { Address, PublicClient, WalletClient } from 'viem';

import { MockPortalAbi, MockPortalBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

export function deployMockPortal(
  walletClient: WalletClient,
  publicClient: PublicClient,
  underlying: Address,
  rollupVersion: bigint,
): Promise<Address> {
  return deployContract(walletClient, publicClient, MockPortalAbi, MockPortalBytecode, [underlying, rollupVersion]);
}
