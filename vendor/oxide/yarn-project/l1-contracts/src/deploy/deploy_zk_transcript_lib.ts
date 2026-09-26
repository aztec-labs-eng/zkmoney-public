import type { Address, PublicClient, WalletClient } from 'viem';

import { ZKTranscriptLibAbi, ZKTranscriptLibBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

export function deployZKTranscriptLib(walletClient: WalletClient, publicClient: PublicClient): Promise<Address> {
  return deployContract(walletClient, publicClient, ZKTranscriptLibAbi, ZKTranscriptLibBytecode);
}
