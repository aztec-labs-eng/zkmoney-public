// Disposable CCTP bridge-on-withdraw feature. Purge this file with its gen_abis, artifacts and index lines.
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
} from 'viem';

import { CCTPBridgeEscrowFactoryAbi, CCTPBridgeEscrowFactoryBytecode } from './artifacts.js';
import { deployContract } from './deploy/deploy_contract.js';
import { assertRecoveryCommitment, predictEscrowAddressLocally } from './escrow.js';

// Re-exported here, not from index.ts, so the purge stays one index line.
export {
  CCTPBridgeEscrowAbi,
  CCTPBridgeEscrowBytecode,
  CCTPBridgeEscrowFactoryAbi,
  CCTPBridgeEscrowFactoryBytecode,
} from './artifacts.js';
export { MockTokenMessengerV2Abi, MockTokenMessengerV2Bytecode } from './artifacts.js';

export enum CctpBridgeRoute {
  Direct = 0,
  /** Mints to the HyperEVM `CctpForwarder`, which credits `recipient` on HyperCore spot. */
  HyperCoreSpot = 1,
}

export const CCTP_HYPEREVM_DOMAIN = 19;

/** CCTP `minFinalityThreshold` values. */
export enum CctpFinality {
  Fast = 1000,
  Standard = 2000,
}

/** Mirror of `CCTPBridgeEscrow.Args`: the values a bridge escrow's CREATE2 address commits to, in struct order. */
export interface CctpBridgeEscrowArgs {
  route: CctpBridgeRoute;
  destinationDomain: number;
  /** For `HyperCoreSpot`, the HyperCore account. */
  recipient: Address;
  minFinalityThreshold: number;
  /** USDC (6 decimals) that Circle takes in full, including the forwarding and HyperCore deposit fees. */
  maxFee: bigint;
  /** `deriveRecoveryCommitment(recoverySalt, account)`. The account signs the escrow's recovery. */
  recoveryCommitment: Hex;
  relayerTip: bigint;
  /** Wallet randomness for per-withdrawal uniqueness/privacy. */
  nonce: Hex;
}

/** Must match `abi.encode(_args)` in `CCTPBridgeEscrowFactory` exactly: it is the CREATE2 commitment. */
export function encodeCctpBridgeEscrowArgs(args: CctpBridgeEscrowArgs): Hex {
  assertCctpBridgeEscrowArgs(args);
  return encodeAbiParameters(getAbiItem({ abi: CCTPBridgeEscrowFactoryAbi, name: 'predictEscrowAddress' }).inputs, [
    args,
  ]);
}

export async function predictCctpBridgeEscrowAddress(
  publicClient: PublicClient,
  factory: Address,
  args: CctpBridgeEscrowArgs,
): Promise<Address> {
  return (await publicClient.readContract({
    address: factory,
    abi: CCTPBridgeEscrowFactoryAbi,
    functionName: 'predictEscrowAddress',
    args: [args],
  } as any)) as Address;
}

export function predictCctpBridgeEscrowAddressLocally(factory: Address, args: CctpBridgeEscrowArgs): Address {
  return predictEscrowAddressLocally(factory, encodeCctpBridgeEscrowArgs(args));
}

export function encodeCctpBridgeEscrowDeploy(args: CctpBridgeEscrowArgs): Hex {
  assertCctpBridgeEscrowArgs(args);
  return encodeFunctionData({ abi: CCTPBridgeEscrowFactoryAbi, functionName: 'deployAndExecute', args: [args] });
}

export async function deployCctpBridgeEscrowFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
  contracts: {
    dai: Address;
    usdc: Address;
    threePool: Address;
    tokenMessenger: Address;
    hyperEvmCctpForwarder: Address;
  },
): Promise<Address> {
  return await deployContract(walletClient, publicClient, CCTPBridgeEscrowFactoryAbi, CCTPBridgeEscrowFactoryBytecode, [
    contracts.dai,
    contracts.usdc,
    contracts.threePool,
    contracts.tokenMessenger,
    contracts.hyperEvmCctpForwarder,
  ]);
}

/** Rejects args that strand the funds at the escrow: a zero recovery commitment, or a burn that reverts. */
function assertCctpBridgeEscrowArgs(args: CctpBridgeEscrowArgs): void {
  assertRecoveryCommitment(args.recoveryCommitment);
  if (BigInt(args.recipient) === 0n) {
    throw new Error('CctpBridgeEscrowArgs: recipient must be nonzero');
  }
  if (args.route === CctpBridgeRoute.HyperCoreSpot && args.destinationDomain !== CCTP_HYPEREVM_DOMAIN) {
    throw new Error(`CctpBridgeEscrowArgs: HyperCoreSpot must burn to domain ${CCTP_HYPEREVM_DOMAIN}`);
  }
  if (args.route !== CctpBridgeRoute.Direct && args.route !== CctpBridgeRoute.HyperCoreSpot) {
    throw new Error(`CctpBridgeEscrowArgs: unknown route ${args.route}`);
  }
}
