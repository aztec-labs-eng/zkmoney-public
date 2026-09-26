import type { Address, PublicClient, WalletClient } from 'viem';

import { EntryPointAbi, EntryPointBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/// Deploys the canonical ERC-4337 EntryPoint v0.8. For e2e/local chains only — public networks
/// already have it at its canonical address.
export function deployEntryPoint(walletClient: WalletClient, publicClient: PublicClient): Promise<Address> {
  return deployContract(walletClient, publicClient, EntryPointAbi, EntryPointBytecode);
}
