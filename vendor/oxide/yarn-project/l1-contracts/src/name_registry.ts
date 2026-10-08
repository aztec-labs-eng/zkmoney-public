import {
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TypedDataDefinition,
  type WalletClient,
  encodeFunctionData,
} from 'viem';

import { NameRegistryAbi } from './artifacts.js';

export type DomainAuthArg = {
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
};
export type NameClaimTypedDataArgs = {
  chainId: bigint | number;
  nameRegistry: Address;
  nameHash: Hex;
  userAddress: Address;
  nonce: bigint;
  deadline: bigint;
};

const NAME_CLAIM_TYPES = {
  NameClaim: [
    { name: 'nameHash', type: 'bytes32' },
    { name: 'userAddress', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
export type NameClaimTypedData = TypedDataDefinition<typeof NAME_CLAIM_TYPES, 'NameClaim'>;

/// The domain owner signs this to authorize `userAddress` to claim `nameHash`.
export function buildNameClaimTypedData(args: NameClaimTypedDataArgs): NameClaimTypedData {
  return {
    domain: {
      name: 'Oxide NameRegistry',
      version: '1',
      chainId: args.chainId,
      verifyingContract: args.nameRegistry,
    },
    primaryType: 'NameClaim',
    types: NAME_CLAIM_TYPES,
    message: {
      nameHash: args.nameHash,
      userAddress: args.userAddress,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  };
}

/// The domain owner's authorization for `userAddress` to claim `nameHash`, in the form `claimName` takes.
export async function signDomainAuth(
  domainOwner: Pick<LocalAccount, 'signTypedData'>,
  args: NameClaimTypedDataArgs,
): Promise<DomainAuthArg> {
  const signature = await domainOwner.signTypedData(buildNameClaimTypedData(args));
  return { nonce: args.nonce, deadline: args.deadline, signature };
}

async function read<T>(publicClient: PublicClient, nameRegistry: Address, functionName: string, args: unknown[]) {
  return (await publicClient.readContract({
    address: nameRegistry,
    abi: NameRegistryAbi as any,
    functionName,
    args,
  } as any)) as T;
}

async function write(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  functionName: string,
  args: unknown[],
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: nameRegistry,
    abi: NameRegistryAbi as any,
    functionName,
    args,
  } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`NameRegistry.${functionName} tx ${hash} reverted in block ${receipt.blockNumber}`);
  }
}

/** `nameHash → account address`. Zero when the name is unregistered. */
export function readUserAddress(publicClient: PublicClient, nameRegistry: Address, nameHash: Hex): Promise<Address> {
  return read<Address>(publicClient, nameRegistry, 'ownerOf', [nameHash]);
}

/** `account address → nameHash`. Zero when the account holds no name. */
export function readNameOf(publicClient: PublicClient, nameRegistry: Address, owner: Address): Promise<Hex> {
  return read<Hex>(publicClient, nameRegistry, 'nameOf', [owner]);
}

export function readDomainOwner(publicClient: PublicClient, nameRegistry: Address): Promise<Address> {
  return read<Address>(publicClient, nameRegistry, 'domainOwner', []);
}

/// The resolution module the registry points at. An earlier generation's SIPA implementations read this to admit a
/// sweep, so on a registry that outlives a generation the pointer stays where those implementations need it.
export function readResolver(publicClient: PublicClient, nameRegistry: Address): Promise<Address> {
  return read<Address>(publicClient, nameRegistry, 'resolver', []);
}

export function readAccountMetadataRegistry(publicClient: PublicClient, nameRegistry: Address): Promise<Address> {
  return read<Address>(publicClient, nameRegistry, 'accountMetadataRegistry', []);
}

export function readRegistrationController(publicClient: PublicClient, nameRegistry: Address): Promise<Address> {
  return read<Address>(publicClient, nameRegistry, 'registrationController', []);
}

// Owner-gated pointer and role updates; `walletClient` must sign as the registry's `Ownable` owner.
export function updateDomainOwner(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  newDomainOwner: Address,
): Promise<void> {
  return write(walletClient, publicClient, nameRegistry, 'updateDomainOwner', [newDomainOwner]);
}

export function updateAccountMetadataRegistry(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  registry: Address,
): Promise<void> {
  return write(walletClient, publicClient, nameRegistry, 'updateAccountMetadataRegistry', [registry]);
}

export function updateResolver(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  resolver: Address,
): Promise<void> {
  return write(walletClient, publicClient, nameRegistry, 'updateResolver', [resolver]);
}

export function updateRegistrationController(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  controller: Address,
): Promise<void> {
  return write(walletClient, publicClient, nameRegistry, 'updateRegistrationController', [controller]);
}

// Controller-gated name writes. Production claims are driven by the RegistrationController on a funded registration
// SIPA; these direct calls only work when `walletClient` signs as the blessed controller (e.g. a test stand-in).
export function claimName(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  nameHash: Hex,
  owner: Address,
  domainAuth: DomainAuthArg,
): Promise<void> {
  return write(walletClient, publicClient, nameRegistry, 'claimName', [nameHash, owner, domainAuth]);
}

export function changeName(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
  owner: Address,
  newNameHash: Hex,
  domainAuth: DomainAuthArg,
): Promise<void> {
  return write(walletClient, publicClient, nameRegistry, 'changeName', [owner, newNameHash, domainAuth]);
}

export function encodeChangeName(owner: Address, newNameHash: Hex, domainAuth: DomainAuthArg): Hex {
  return encodeFunctionData({
    abi: NameRegistryAbi as any,
    functionName: 'changeName',
    args: [owner, newNameHash, domainAuth],
  });
}
