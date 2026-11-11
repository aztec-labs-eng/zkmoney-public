import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  numberToHex,
  zeroHash,
} from 'viem';

import { SIPAFactoryAbi } from './artifacts.js';

/** Creation args that fix a SIPA's deterministic create2 address. The clone commits to `(implementation, intentHash)`
 *  plus the recovery commitment, the rollup version, the single-sweep flag and the forwarding table; `implementation`
 *  is the intent type (deposit, registration, ...). The table gives the portal and the sweep tip for each token that
 *  the SIPA receives. */
export interface SipaDeployArgs {
  implementation: Address;
  /** `keccak256(intentData)` — the single word the clone commits to. */
  intentHash: Hex;
  recoveryCommitment: Hex;
  rollupVersion: bigint;
  resweepable: boolean;
  forwardingTable: Address;
}

/** The Solidity `Intent` (`Intent.sol`) — the family an implementation declares and the factory records against it. */
export enum SipaIntent {
  None = 0,
  Deposit = 1,
  Registration = 2,
  // 3 was UserOp, now deprecated. Do not reuse it: a factory that blessed UserOpSIPA keeps it as intent 3.
  AddPasskey = 4,
}

export function encodeDeploySIPA(args: SipaDeployArgs): Hex {
  return encodeFunctionData({
    abi: SIPAFactoryAbi,
    functionName: 'deploySIPA',
    args: [
      args.implementation,
      args.intentHash,
      args.recoveryCommitment,
      args.rollupVersion,
      args.resweepable,
      args.forwardingTable,
    ],
  });
}

/** The implementation that new SIPAs use for `intent`, on every approved table. Zero when the factory has no
 *  implementation for that intent. The owner can point the intent to a new implementation, and this changes the address
 *  of every new SIPA. Thus do not keep the answer for longer than one resolution. */
export async function readSIPAImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
  intent: SipaIntent,
): Promise<Address> {
  return (await publicClient.readContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'implementationFor',
    args: [intent],
  } as any)) as Address;
}

/** True when the factory approved `forwardingTable`. The factory recognizes a SIPA only when its table is approved.
 *  Approval is add-only. */
export async function readApprovedTable(
  publicClient: PublicClient,
  sipaFactory: Address,
  forwardingTable: Address,
): Promise<boolean> {
  return (await publicClient.readContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'approvedTable',
    args: [forwardingTable],
  } as any)) as boolean;
}

/** The family `implementation` is blessed as, or {@link SipaIntent.None} when it is not blessed at all. Blessing is
 *  add-only, so this stays true for an implementation after a new implementation takes its intent. */
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
  forwardingTable: Address,
): Promise<Address> {
  return (await publicClient.readContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: 'predictSIPA',
    args: [implementation, intentHash, recoveryCommitment, rollupVersion, resweepable, forwardingTable],
  } as any)) as Address;
}

/** The SIPA args that `SIPAFactory._args` encodes: `abi.encode(SIPABase.Args)`. */
const SIPA_ARGS = [
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'uint256' },
  { type: 'bool' },
  { type: 'address' },
] as const;

/**
 * The address that `sipaFactory.predictSIPA(args)` returns, computed without a call. The factory deploys each SIPA as an
 * OpenZeppelin clone with immutable args and a zero salt, so the address is the create2 address of the clone code. Use
 * it to test many candidate factories and implementations against an address. It does not check that the recovery
 * commitment fits the L2 field, which `predictSIPA` requires.
 */
export function computeSIPAAddress(sipaFactory: Address, args: SipaDeployArgs): Address {
  const encoded = encodeAbiParameters(SIPA_ARGS, [
    args.intentHash,
    args.recoveryCommitment,
    args.rollupVersion,
    args.resweepable,
    args.forwardingTable,
  ]);
  const argsLength = (encoded.length - 2) / 2;
  const bytecode = concatHex([
    '0x61',
    numberToHex(argsLength + 0x2d, { size: 2 }),
    '0x3d81600a3d39f3363d3d373d3d3d363d73',
    args.implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
    encoded,
  ]);
  return getContractAddress({ opcode: 'CREATE2', from: sipaFactory, salt: zeroHash, bytecode });
}
