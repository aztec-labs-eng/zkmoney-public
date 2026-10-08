import { type Address, type Hex, type PublicClient, encodeFunctionData } from 'viem';

import { SIPAFactoryAbi } from './artifacts.js';

/** Creation args that fix a SIPA's deterministic create2 address. The clone commits to `(implementation, intentHash)`
 *  plus the recovery commitment, the rollup version, and the single-sweep flag; `implementation` is the intent type
 *  (deposit, registration, ...). The portal is deliberately absent: it is an immutable of the implementation,
 *  so it follows from the implementation the address already commits to. */
export interface SipaDeployArgs {
  implementation: Address;
  /** `keccak256(intentData)` — the single word the clone commits to. */
  intentHash: Hex;
  recoveryCommitment: Hex;
  rollupVersion: bigint;
  resweepable: boolean;
}

/** `SIPABase.Intent` — the family an implementation declares and the factory records against it. */
export enum SipaIntent {
  None = 0,
  Deposit = 1,
  Registration = 2,
  UpdateMetadata = 3,
}

export function encodeDeploySIPA(args: SipaDeployArgs): Hex {
  return encodeFunctionData({
    abi: SIPAFactoryAbi,
    functionName: 'deploySIPA',
    args: [args.implementation, args.intentHash, args.recoveryCommitment, args.rollupVersion, args.resweepable],
  });
}

/** The implementation new resolutions against `portal` predict against for `intent`. Zero where that portal has
 *  none blessed for that intent — a client must not fall back to another portal's or another intent's. The factory
 *  writes each `(portal, intent)` pointer once, so a caller may memoize the answer for as long as the portal lives. */
export async function readSIPAImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
  portal: Address,
  intent: SipaIntent,
): Promise<Address> {
  return (await publicClient.readContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'implementationFor',
    args: [portal, intent],
  } as any)) as Address;
}

/** The family `implementation` is blessed as, or {@link SipaIntent.None} when it is not blessed at all. Blessing is
 *  add-only, so this stays true for every portal's implementations once recorded. */
export async function readBlessedIntent(
  publicClient: PublicClient,
  sipaFactory: Address,
  implementation: Address,
): Promise<SipaIntent> {
  const intent = (await publicClient.readContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'intentOf',
    args: [implementation],
  } as any)) as number;
  return intent as SipaIntent;
}

export async function predictSIPA(
  publicClient: PublicClient,
  sipaFactory: Address,
  implementation: Address,
  intentHash: Hex,
  recoveryCommitment: Hex,
  rollupVersion: bigint,
  resweepable: boolean,
): Promise<Address> {
  return (await publicClient.readContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'predictSIPA',
    args: [implementation, intentHash, recoveryCommitment, rollupVersion, resweepable],
  } as any)) as Address;
}
