// Disposable Across bridge-on-withdraw feature. Purge this file with its gen_abis, artifacts and index lines.
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
} from 'viem';

import { AcrossBridgeEscrowFactoryAbi, AcrossBridgeEscrowFactoryBytecode } from './artifacts.js';
import { deployContract } from './deploy/deploy_contract.js';
import { assertRecoveryCommitment, predictEscrowAddressLocally } from './escrow.js';

// Re-exported here, not from index.ts, so the purge stays one index line.
export {
  AcrossBridgeEscrowAbi,
  AcrossBridgeEscrowBytecode,
  AcrossBridgeEscrowFactoryAbi,
  AcrossBridgeEscrowFactoryBytecode,
} from './artifacts.js';
export { MockAcrossSpokePoolAbi, MockAcrossSpokePoolBytecode } from './artifacts.js';

/** Mirrors `AcrossBridgeEscrow.ACROSS_INPUT_TOKEN_DECIMALS`. */
export const ACROSS_INPUT_TOKEN_DECIMALS = 6;

/** Mirror of `AcrossBridgeEscrow.Args`: the values a bridge escrow's CREATE2 address commits to, in struct order. */
export interface AcrossBridgeEscrowArgs {
  /** USDC or USDT. */
  acrossInputToken: Address;
  destinationChainId: bigint;
  recipient: Address;
  acrossOutputToken: Address;
  acrossOutputTokenDecimals: number;
  /** In `acrossInputToken` units, including the destination gas. */
  acrossFee: bigint;
  /** `deriveRecoveryCommitment(recoverySalt, account)`. The account signs the escrow's recovery. */
  recoveryCommitment: Hex;
  relayerTip: bigint;
  /** Wallet randomness for per-withdrawal uniqueness/privacy. */
  nonce: Hex;
}

/** Must match `abi.encode(_args)` in `AcrossBridgeEscrowFactory` exactly: it is the CREATE2 commitment. */
export function encodeAcrossBridgeEscrowArgs(args: AcrossBridgeEscrowArgs): Hex {
  assertAcrossBridgeEscrowArgs(args);
  return encodeAbiParameters(getAbiItem({ abi: AcrossBridgeEscrowFactoryAbi, name: 'predictEscrowAddress' }).inputs, [
    args,
  ]);
}

export async function predictAcrossBridgeEscrowAddress(
  publicClient: PublicClient,
  factory: Address,
  args: AcrossBridgeEscrowArgs,
): Promise<Address> {
  return (await publicClient.readContract({
    address: factory,
    abi: AcrossBridgeEscrowFactoryAbi,
    functionName: 'predictEscrowAddress',
    args: [args],
  } as any)) as Address;
}

export function predictAcrossBridgeEscrowAddressLocally(factory: Address, args: AcrossBridgeEscrowArgs): Address {
  return predictEscrowAddressLocally(factory, encodeAcrossBridgeEscrowArgs(args));
}

export function encodeAcrossBridgeEscrowDeploy(args: AcrossBridgeEscrowArgs): Hex {
  assertAcrossBridgeEscrowArgs(args);
  return encodeFunctionData({ abi: AcrossBridgeEscrowFactoryAbi, functionName: 'deployAndExecute', args: [args] });
}

export function assertAcrossOutputTokenDecimals(acrossOutputTokenDecimals: number): void {
  if (acrossOutputTokenDecimals < ACROSS_INPUT_TOKEN_DECIMALS) {
    throw new Error(
      `acrossOutputTokenDecimals (${acrossOutputTokenDecimals}) must be at least ${ACROSS_INPUT_TOKEN_DECIMALS}`,
    );
  }
}

export async function deployAcrossBridgeEscrowFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
  contracts: { dai: Address; usdc: Address; usdt: Address; threePool: Address; spokePool: Address },
): Promise<Address> {
  return await deployContract(
    walletClient,
    publicClient,
    AcrossBridgeEscrowFactoryAbi,
    AcrossBridgeEscrowFactoryBytecode,
    [contracts.dai, contracts.usdc, contracts.usdt, contracts.threePool, contracts.spokePool],
  );
}

function assertAcrossBridgeEscrowArgs(args: AcrossBridgeEscrowArgs): void {
  assertRecoveryCommitment(args.recoveryCommitment);
  if (BigInt(args.recipient) === 0n) {
    throw new Error('AcrossBridgeEscrowArgs: recipient must be nonzero');
  }
  assertAcrossOutputTokenDecimals(args.acrossOutputTokenDecimals);
}
