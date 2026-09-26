import type { Address, PublicClient, WalletClient } from 'viem';

import { NameRegistryAbi, NameRegistryBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

export function deployNameRegistry(
  walletClient: WalletClient,
  publicClient: PublicClient,
  owner: Address,
  domainOwner: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, NameRegistryAbi, NameRegistryBytecode, [owner, domainOwner]);
}
