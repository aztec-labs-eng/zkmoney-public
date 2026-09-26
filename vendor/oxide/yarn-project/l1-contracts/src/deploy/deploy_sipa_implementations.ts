import type { Address, PublicClient, WalletClient } from 'viem';

import {
  DepositSIPAAbi,
  DepositSIPABytecode,
  RegistrationSIPAAbi,
  RegistrationSIPABytecode,
  SIPAFactoryAbi,
} from '../artifacts.js';
import { deployContract } from './deploy_contract.js';

/**
 * The sender-funded sweep fee each intent implementation pins, mirroring the Solidity file-level constants in
 * `DepositSIPA.sol` and `RegistrationSIPA.sol`. They are constructor arguments rather than ABI members, so a
 * deployer has to supply them; `l1_verify` reads `depositFee()` back off each implementation to catch drift.
 *
 * The two differ because the two sweeps do: a registration writes two registries, deploys the owner's 4337 account
 * and notifies the name portal, where a plain bridge does none of it. The registration figure is the relayer's cut
 * of the registration fee; the remainder reaches the FPC funder.
 */
export const DEPOSIT_SWEEP_FEE = 250_000_000_000_000_000n;
export const REGISTRATION_SWEEP_FEE = 500_000_000_000_000_000n;

/** One rollup version's intent implementations, as deployed and blessed. */
export interface SIPAImplementations {
  depositSIPAImplementation: Address;
  registrationSIPAImplementation: Address;
}

/** The deposit-intent implementation for one rollup version. `portal` is that version's Portal; the portal and the
 *  fee both become implementation immutables, so every clone settles into the one and charges the other. */
export function deployDepositSIPA(
  walletClient: WalletClient,
  publicClient: PublicClient,
  portal: Address,
  fee: bigint = DEPOSIT_SWEEP_FEE,
): Promise<Address> {
  return deployContract(walletClient, publicClient, DepositSIPAAbi, DepositSIPABytecode, [portal, fee]);
}

/** The registration-intent implementation for one rollup version; the deposit one's sibling over the same portal, on
 *  its own fee. It also pins the environment's NameRegistry, which it reads the registration controller off at sweep
 *  time. */
export function deployRegistrationSIPA(
  walletClient: WalletClient,
  publicClient: PublicClient,
  portal: Address,
  nameRegistry: Address,
  fee: bigint = REGISTRATION_SWEEP_FEE,
): Promise<Address> {
  return deployContract(walletClient, publicClient, RegistrationSIPAAbi, RegistrationSIPABytecode, [
    portal,
    nameRegistry,
    fee,
  ]);
}

/**
 * Add one implementation to the factory's blessed set, and point new resolutions against its `(portal, intent)` pair
 * at it.
 *
 * Add-only, so this never takes an earlier version's implementation out of the set and never strands a SIPA already
 * funded against one. `walletClient` must sign as the factory's owner. Neither key is passed: the factory reads the
 * portal and the intent off the implementation itself.
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
    functionName: 'bless',
    args: [implementation],
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`SIPAFactory.bless(${implementation}) reverted in tx ${hash}`);
  }
}

/**
 * Deploy both intent implementations serving one rollup version and bless them on the permanent factory.
 *
 * Each pins that version's Portal and its own sweep fee, which is what makes the pair version-scoped while the
 * factory stays environment-level: the factory constructs neither, so it can predate both.
 */
export async function deploySIPAImplementations(
  walletClient: WalletClient,
  publicClient: PublicClient,
  args: {
    sipaFactory: Address;
    portal: Address;
    nameRegistry: Address;
    depositFee?: bigint;
    registrationFee?: bigint;
  },
): Promise<SIPAImplementations> {
  const depositSIPAImplementation = await deployDepositSIPA(
    walletClient,
    publicClient,
    args.portal,
    args.depositFee ?? DEPOSIT_SWEEP_FEE,
  );
  const registrationSIPAImplementation = await deployRegistrationSIPA(
    walletClient,
    publicClient,
    args.portal,
    args.nameRegistry,
    args.registrationFee ?? REGISTRATION_SWEEP_FEE,
  );

  for (const implementation of [depositSIPAImplementation, registrationSIPAImplementation]) {
    await blessSIPAImplementation(walletClient, publicClient, args.sipaFactory, implementation);
  }

  return { depositSIPAImplementation, registrationSIPAImplementation };
}
