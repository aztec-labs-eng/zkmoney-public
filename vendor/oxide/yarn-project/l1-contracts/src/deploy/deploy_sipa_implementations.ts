import type { Address, PublicClient, WalletClient } from 'viem';

import {
  DepositSIPAAbi,
  DepositSIPABytecode,
  RegistrationSIPAAbi,
  RegistrationSIPABytecode,
  SIPAFactoryAbi,
  UserOpSIPAAbi,
  UserOpSIPABytecode,
} from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/** One rollup version's intent implementations, as deployed and blessed. */
export interface SIPAImplementations {
  depositSIPAImplementation: Address;
  registrationSIPAImplementation: Address;
  userOpSIPAImplementation: Address;
}

/** The deposit-intent implementation. It has no immutables: each clone reads its portal and its tip from the
 *  forwarding table in its args. */
export function deployDepositSIPA(walletClient: WalletClient, publicClient: PublicClient): Promise<Address> {
  return deployContract(walletClient, publicClient, DepositSIPAAbi, DepositSIPABytecode, []);
}

/** The registration-intent implementation. It pins the environment's NameRegistry, from which it reads the
 *  registration controller at sweep time. */
export function deployRegistrationSIPA(
  walletClient: WalletClient,
  publicClient: PublicClient,
  nameRegistry: Address,
): Promise<Address> {
  return deployContract(walletClient, publicClient, RegistrationSIPAAbi, RegistrationSIPABytecode, [nameRegistry]);
}

/**
 * Add one implementation to the factory's blessed set, and point new SIPAs of its intent to it.
 *
 * The factory reads the intent from the implementation. A new pointing changes the address of every new SIPA of that
 * intent. The blessed set is add-only, so a SIPA of an earlier implementation stays blessed and can still sweep.
 * `walletClient` must sign as the factory's owner.
 */
export async function blessSIPAImplementation(
  walletClient: WalletClient,
  publicClient: PublicClient,
  sipaFactory: Address,
  implementation: Address,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'blessImplementation',
    args: [implementation],
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`SIPAFactory.blessImplementation(${implementation}) reverted in tx ${hash}`);
  }
}

/**
 * Approve `forwardingTable`, so the factory recognizes SIPAs on it. Approval is add-only. `walletClient` must sign as
 * the factory's owner.
 */
export async function blessForwardingTable(
  walletClient: WalletClient,
  publicClient: PublicClient,
  sipaFactory: Address,
  forwardingTable: Address,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'blessTable',
    args: [forwardingTable],
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`SIPAFactory.blessTable(${forwardingTable}) reverted in tx ${hash}`);
  }
}

export function deployUserOpSIPA(walletClient: WalletClient, publicClient: PublicClient): Promise<Address> {
  return deployContract(walletClient, publicClient, UserOpSIPAAbi, UserOpSIPABytecode, []);
}

/** Deploy all three intent implementations, bless them, and approve `forwardingTable`. */
export async function deploySIPAImplementations(
  walletClient: WalletClient,
  publicClient: PublicClient,
  args: {
    sipaFactory: Address;
    forwardingTable: Address;
    nameRegistry: Address;
  },
): Promise<SIPAImplementations> {
  const depositSIPAImplementation = await deployDepositSIPA(walletClient, publicClient);
  const registrationSIPAImplementation = await deployRegistrationSIPA(walletClient, publicClient, args.nameRegistry);
  const userOpSIPAImplementation = await deployUserOpSIPA(walletClient, publicClient);
  for (const implementation of [depositSIPAImplementation, registrationSIPAImplementation, userOpSIPAImplementation]) {
    await blessSIPAImplementation(walletClient, publicClient, args.sipaFactory, implementation);
  }
  await blessForwardingTable(walletClient, publicClient, args.sipaFactory, args.forwardingTable);

  return {
    depositSIPAImplementation,
    registrationSIPAImplementation,
    userOpSIPAImplementation,
  };
}
