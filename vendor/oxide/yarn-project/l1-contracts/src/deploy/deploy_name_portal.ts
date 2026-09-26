import type { Address, PublicClient, WalletClient } from 'viem';

import { NamePortalAbi, NamePortalBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/** Deploys the NamePortal bound to `nameRegistry` and the `aztecRegistry` it resolves rollup versions through. */
export function deployNamePortal(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  aztecRegistry: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, NamePortalAbi, NamePortalBytecode, [nameRegistry, aztecRegistry]);
}
