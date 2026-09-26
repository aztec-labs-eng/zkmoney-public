import type { Address, PublicClient, WalletClient } from 'viem';

import { OxidePaymasterAbi, OxidePaymasterBytecode } from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/// Deploys the paymaster bound to `entryPoint`, sponsoring ops signed by `signer` and authorizes `bundler` as
/// the allowed bundler.
export function deployOxidePaymaster(
  walletClient: WalletClient,
  publicClient: PublicClient,
  entryPoint: Address,
  signer: Address,
  bundler: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, OxidePaymasterAbi, OxidePaymasterBytecode, [
    entryPoint,
    signer,
    bundler,
  ]);
}
