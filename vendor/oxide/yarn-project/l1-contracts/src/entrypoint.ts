import { type Address, type Hex, type PublicClient, type WalletClient, concatHex, pad, toHex } from 'viem';
import { z } from 'zod';

import { EntryPointAbi } from './artifacts.js';
import { type ContractWriteResult, type WriteOptions, maybeWaitForReceipt } from './write_receipt.js';
import { addressSchema, bytes32Schema, hexSchema, uintSchema } from './zod.js';

/// The canonical ERC-4337 EntryPoint v0.8, the singleton `OxideAccount.entryPoint()` pins on every chain.
export const CANONICAL_ENTRY_POINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

/// EntryPoint v0.8 `PackedUserOperation`.
export type PackedUserOperation = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type UserOpGas = {
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export const packedUserOperationSchema = z.object({
  sender: addressSchema,
  nonce: uintSchema,
  initCode: hexSchema,
  callData: hexSchema,
  accountGasLimits: bytes32Schema,
  preVerificationGas: uintSchema,
  gasFees: bytes32Schema,
  paymasterAndData: hexSchema,
  signature: hexSchema,
});

/// JSON wire form of a `PackedUserOperation`: bigints as decimal strings, everything else hex.
export type UserOpJson = Record<keyof PackedUserOperation, string>;

export function userOpToJson(op: PackedUserOperation): UserOpJson {
  return {
    sender: op.sender,
    nonce: op.nonce.toString(),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: op.preVerificationGas.toString(),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

/// Packs two 128-bit limbs into a bytes32 (high limb first, low limb second).
export function packU128LimbsToBytes32(high: bigint, low: bigint): Hex {
  return concatHex([pad(toHex(high), { size: 16 }), pad(toHex(low), { size: 16 })]);
}

/// Builds a `PackedUserOperation` with an empty signature, ready to hash and sign. Gas limits default
/// to measured costs plus headroom: WebAuthn/P-256 validation via the EIP-7951 precompile is ~20k, so
/// 150k covers it with prefund-transfer and EntryPoint overhead. Pass `initCode` to deploy the account in
/// the same op; the account clone deployment (~75k) runs under the verification gas limit, so its default
/// doubles. Pass `paymasterAndData` to have a paymaster sponsor the op instead of the account paying from
/// its own balance/deposit.
export function buildUserOp(params: {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  initCode?: Hex;
  gas?: UserOpGas;
  paymasterAndData?: Hex;
  signature?: Hex; // Use a dummy signature here for gas estimations.
}): PackedUserOperation {
  const gas = params.gas ?? {};
  const initCode = params.initCode ?? '0x';
  const verificationGasLimit = gas.verificationGasLimit ?? (initCode !== '0x' ? 300_000n : 150_000n);
  const callGasLimit = gas.callGasLimit ?? 300_000n;
  const maxPriorityFeePerGas = gas.maxPriorityFeePerGas ?? 1_000_000_000n;
  const maxFeePerGas = gas.maxFeePerGas ?? 2_000_000_000n;
  return {
    sender: params.sender,
    nonce: params.nonce,
    initCode,
    callData: params.callData,
    accountGasLimits: packU128LimbsToBytes32(verificationGasLimit, callGasLimit),
    preVerificationGas: gas.preVerificationGas ?? 200_000n,
    gasFees: packU128LimbsToBytes32(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: params.paymasterAndData ?? '0x',
    signature: params.signature ?? '0x',
  };
}

/// The account's next nonce in the canonical (key 0) sequence.
export async function getAccountNonce(
  publicClient: PublicClient,
  entryPoint: Address,
  account: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: entryPoint,
    abi: EntryPointAbi,
    functionName: 'getNonce',
    args: [account, 0n],
  } as any)) as bigint;
}

/// The EntryPoint's hash of `userOp` — the value the account's r1 key signs over (the WebAuthn challenge).
export async function getUserOpHash(
  publicClient: PublicClient,
  entryPoint: Address,
  userOp: PackedUserOperation,
): Promise<Hex> {
  return (await publicClient.readContract({
    address: entryPoint,
    abi: EntryPointAbi,
    functionName: 'getUserOpHash',
    args: [userOp],
  } as any)) as Hex;
}

/// Submits user operations through the EntryPoint, paying any prefund from the accounts' balances and
/// refunding gas to `beneficiary`. This is the relayer/bundler step.
export async function handleOps(
  walletClient: WalletClient,
  publicClient: PublicClient,
  entryPoint: Address,
  ops: PackedUserOperation[],
  beneficiary: Address,
  options: WriteOptions = {},
): Promise<ContractWriteResult> {
  const txHash = (await walletClient.writeContract({
    address: entryPoint,
    abi: EntryPointAbi,
    functionName: 'handleOps',
    args: [ops, beneficiary],
  } as any)) as Hex;
  return maybeWaitForReceipt(publicClient, txHash, options);
}
