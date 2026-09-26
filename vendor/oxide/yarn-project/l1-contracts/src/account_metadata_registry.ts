import { type Address, type Hex, type PublicClient, type WalletClient, encodeFunctionData } from 'viem';

import { AccountMetadataRegistryAbi } from './artifacts.js';

export type K1PointArg = { x: bigint; y: bigint };
export type UserRecordArg = {
  l2Address: Hex;
  rollupVersion: bigint;
  publicKey: K1PointArg;
  /** Which gateway operator serves this user (keys the ResolverOperator entry). */
  resolverOperator: Address;
};
export type ResolverOperatorArg = {
  publicKey: K1PointArg;
  l2Address: Hex;
  url: string;
  oxidePortal: Address;
};

// Calldata builders for the user-or-controller-gated record functions. A user calls them from their 4337 account, so
// these are meant to be wrapped in an account `execute` / UserOp.
export function encodeSetUserRecord(user: Address, record: UserRecordArg): Hex {
  return encodeFunctionData({
    abi: AccountMetadataRegistryAbi as any,
    functionName: 'setUserRecord',
    args: [user, record],
  });
}

export function encodeUpdateL2Address(user: Address, l2Address: Hex, rollupVersion: bigint): Hex {
  return encodeFunctionData({
    abi: AccountMetadataRegistryAbi as any,
    functionName: 'updateL2Address',
    args: [user, l2Address, rollupVersion],
  });
}

export function encodeUpdatePublicKey(user: Address, publicKey: K1PointArg): Hex {
  return encodeFunctionData({
    abi: AccountMetadataRegistryAbi as any,
    functionName: 'updatePublicKey',
    args: [user, publicKey],
  });
}

export function encodeUpdateUserResolverOperator(user: Address, resolverOperator: Address): Hex {
  return encodeFunctionData({
    abi: AccountMetadataRegistryAbi as any,
    functionName: 'updateUserResolverOperator',
    args: [user, resolverOperator],
  });
}

/** The user's record; reverts when the user has none in this registry (check `hasUserRecord` first). */
export async function getUserRecord(
  publicClient: PublicClient,
  registry: Address,
  user: Address,
): Promise<UserRecordArg> {
  return (await publicClient.readContract({
    address: registry,
    abi: AccountMetadataRegistryAbi as any,
    functionName: 'getUserRecord',
    args: [user],
  } as any)) as UserRecordArg;
}

export async function hasUserRecord(publicClient: PublicClient, registry: Address, user: Address): Promise<boolean> {
  return (await publicClient.readContract({
    address: registry,
    abi: AccountMetadataRegistryAbi as any,
    functionName: 'hasUserRecord',
    args: [user],
  } as any)) as boolean;
}

export async function readResolverOperator(
  publicClient: PublicClient,
  registry: Address,
  resolverOperator: Address,
): Promise<ResolverOperatorArg> {
  const [publicKey, l2Address, url, oxidePortal] = (await publicClient.readContract({
    address: registry,
    abi: AccountMetadataRegistryAbi,
    functionName: 'resolverOperators',
    args: [resolverOperator],
  } as any)) as [K1PointArg, Hex, string, Address];
  return { publicKey, l2Address, url, oxidePortal };
}

/// Write `user`'s record; `walletClient` must sign as `user` or as the blessed registration controller.
export async function setUserRecord(
  walletClient: WalletClient,
  publicClient: PublicClient,
  registry: Address,
  user: Address,
  record: UserRecordArg,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: registry,
    abi: AccountMetadataRegistryAbi as any,
    functionName: 'setUserRecord',
    args: [user, record],
  } as any);
  await publicClient.waitForTransactionReceipt({ hash });
}

/// Create or replace the caller's resolver-operator entry — an upsert keyed by msg.sender. Discovery is via
/// `ResolverOperatorUpdated` events; the registry keeps no operator enumeration.
export async function setResolverOperator(
  walletClient: WalletClient,
  publicClient: PublicClient,
  registry: Address,
  entry: ResolverOperatorArg,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: registry,
    abi: AccountMetadataRegistryAbi,
    functionName: 'setResolverOperator',
    args: [entry],
  } as any);
  await publicClient.waitForTransactionReceipt({ hash });
}
