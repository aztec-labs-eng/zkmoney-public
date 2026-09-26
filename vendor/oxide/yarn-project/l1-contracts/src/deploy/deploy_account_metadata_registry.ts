import type { Address, PublicClient, WalletClient } from 'viem';

import { AccountMetadataRegistryAbi, AccountMetadataRegistryBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

export function deployAccountMetadataRegistry(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, AccountMetadataRegistryAbi, AccountMetadataRegistryBytecode, [
    nameRegistry,
  ]);
}
