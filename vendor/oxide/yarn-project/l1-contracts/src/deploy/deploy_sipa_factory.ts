import type { Address, PublicClient, WalletClient } from 'viem';

import { SIPAFactoryAbi, SIPAFactoryBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/**
 * The permanent, environment-level CREATE2 deployer every SIPA address commits to. It constructs no implementation
 * of its own, so it depends on nothing and is deployed once, before any rollup version exists.
 *
 * `owner` gates `bless`: the deploy key that owns the `NameRegistry` pointers also owns the blessed set, and each
 * version's deploy adds that version's implementations to it.
 */
export function deploySIPAFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
  owner: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, SIPAFactoryAbi, SIPAFactoryBytecode, [owner]);
}
