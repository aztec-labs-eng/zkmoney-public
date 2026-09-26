import type { Address, PublicClient, WalletClient } from 'viem';

import { SIPAResolverAbi, SIPAResolverBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

export function deploySIPAResolver(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  sipaFactory: Address,
  verifier: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, SIPAResolverAbi, SIPAResolverBytecode, [
    nameRegistry,
    sipaFactory,
    verifier,
  ]);
}
