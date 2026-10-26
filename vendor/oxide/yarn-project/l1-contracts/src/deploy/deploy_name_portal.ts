import type { Address, PublicClient, WalletClient } from 'viem';

import { NamePortalAbi, NamePortalBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/** Deploys the NamePortal with its name registry, Aztec registry and account factory. */
export function deployNamePortal(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  aztecRegistry: Address,
  accountFactory: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, NamePortalAbi, NamePortalBytecode, [
    nameRegistry,
    aztecRegistry,
    accountFactory,
  ]);
}
