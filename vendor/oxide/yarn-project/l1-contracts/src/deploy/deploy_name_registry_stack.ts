import type { Address, PublicClient, WalletClient } from 'viem';

import { updateAccountMetadataRegistry, updateResolver } from '../name_registry.js';
import { deployAccountMetadataRegistry } from './deploy_account_metadata_registry.js';
import { deployNameRegistry } from './deploy_name_registry.js';
import { deploySIPAFactory } from './deploy_sipa_factory.js';
import { deploySIPAResolver } from './deploy_sipa_resolver.js';

/**
 * A fresh name-resolution stack: a new `NameRegistry` and a new `SIPAFactory`, the `AccountMetadataRegistry` and the
 * `SIPAResolver` module bound to `verifier`, with the new registry pointed at the last two.
 *
 * Each pointer write goes to the registry this function deploys, and it goes unconditionally. A caller that must keep
 * a registry which an earlier generation still reads cannot come through here, because it decides each pointer
 * itself. The deployment-env step is that caller.
 */
export async function deployNameRegistryStack(
  walletClient: WalletClient,
  publicClient: PublicClient,
  verifier: Address,
  domainOwner: Address,
): Promise<{ nameRegistry: Address; accountMetadataRegistry: Address; sipaFactory: Address; sipaResolver: Address }> {
  const deployer = walletClient.account?.address;
  if (!deployer) {
    throw new Error('walletClient has no account to deploy the NameRegistry stack from');
  }

  const nameRegistry = await deployNameRegistry(walletClient, publicClient, deployer, domainOwner);
  const sipaFactory = await deploySIPAFactory(walletClient, publicClient, deployer);
  const accountMetadataRegistry = await deployAccountMetadataRegistry(walletClient, publicClient, nameRegistry);
  const sipaResolver = await deploySIPAResolver(walletClient, publicClient, nameRegistry, sipaFactory, verifier);

  await updateAccountMetadataRegistry(walletClient, publicClient, nameRegistry, accountMetadataRegistry);
  await updateResolver(walletClient, publicClient, nameRegistry, sipaResolver);

  return { nameRegistry, accountMetadataRegistry, sipaFactory, sipaResolver };
}
