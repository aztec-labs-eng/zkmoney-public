import type { Address, PublicClient, WalletClient } from 'viem';

import { OxideAccountFactoryAbi, OxideAccountFactoryBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

export function deployOxideAccountFactory(walletClient: WalletClient, publicClient: PublicClient): Promise<Address> {
  return deployContract(walletClient, publicClient, OxideAccountFactoryAbi, OxideAccountFactoryBytecode);
}
