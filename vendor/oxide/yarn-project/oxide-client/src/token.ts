import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { ContractInstanceWithAddress } from '@aztec-labs/stdlib/contract';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';

import { OxideTokenContract } from '@oxide/noir-contracts.js/OxideToken';
import type { OxideTokenImmutables } from '@oxide/oxide-lib/token_immutables.js';

import {
  isOxideTokenLockedToArtifact,
  predictOxideTokenInstanceWithArtifact,
  publishAndLockOxideTokenWithArtifact,
  registerOxideTokenWithArtifact,
} from './token_registration.js';

/** The token instance that `immutables` commit to. */
export function predictOxideTokenInstance(immutables: OxideTokenImmutables): Promise<ContractInstanceWithAddress> {
  return predictOxideTokenInstanceWithArtifact(OxideTokenContract.artifact, immutables);
}

/**
 * Registers the token at `address` and stores its immutables.
 *
 * Throws if the immutables do not give `address`.
 */
export async function registerOxideToken(
  wallet: Wallet,
  immutables: OxideTokenImmutables,
  address: AztecAddress,
): Promise<OxideTokenContract> {
  const token = await registerOxideTokenWithArtifact(wallet, OxideTokenContract.artifact, immutables, address);
  return OxideTokenContract.at(token.address, wallet);
}

/**
 * Publishes the token's instance, and its class if the class is not published yet. Then locks its class-update delay.
 *
 * It then stores the immutables, like {@link registerOxideToken}.
 */
export async function publishAndLockOxideToken(
  wallet: Wallet,
  immutables: OxideTokenImmutables,
  from: AztecAddress,
): Promise<OxideTokenContract> {
  const token = await publishAndLockOxideTokenWithArtifact(wallet, OxideTokenContract.artifact, immutables, from);
  return OxideTokenContract.at(token.address, wallet);
}

/** Whether the token is locked to the `OxideToken` class. See {@link isOxideTokenLockedToArtifact}. */
export function isOxideTokenLocked(
  node: Pick<AztecNode, 'getContract' | 'getPublicStorageAt'>,
  token: AztecAddress,
): Promise<boolean> {
  return isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, token);
}
