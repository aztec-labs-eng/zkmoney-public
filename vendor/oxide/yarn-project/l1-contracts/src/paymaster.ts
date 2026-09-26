import { type Address, type Hex, type PublicClient, type WalletClient, concatHex, pad, toHex } from 'viem';

import { EntryPointAbi, OxidePaymasterAbi } from './artifacts.js';
import type { PackedUserOperation } from './entrypoint.js';

/// Packs a v0.8 `paymasterAndData`: paymaster(20) ++ verificationGasLimit(16) ++ postOpGasLimit(16) ++ data.
export function packPaymasterAndData(
  paymaster: Address,
  verificationGasLimit: bigint,
  postOpGasLimit: bigint,
  data: Hex = '0x',
): Hex {
  return concatHex([
    paymaster,
    pad(toHex(verificationGasLimit), { size: 16 }),
    pad(toHex(postOpGasLimit), { size: 16 }),
    data,
  ]);
}

/// The `OxidePaymaster` paymasterData body: validUntil(6) ++ validAfter(6) ++ sponsor signature.
/// Pass an empty signature to build the stub whose `getHash` the sponsor signs.
export function encodeOxidePaymasterData(validUntil: bigint, validAfter: bigint, signature: Hex = '0x'): Hex {
  return concatHex([pad(toHex(validUntil), { size: 6 }), pad(toHex(validAfter), { size: 6 }), signature]);
}

/// The digest the sponsor signs (as an EIP-191 personal message) to authorize the paymaster to pay.
export async function getPaymasterHash(
  publicClient: PublicClient,
  paymaster: Address,
  userOp: PackedUserOperation,
  validUntil: bigint,
  validAfter: bigint,
): Promise<Hex> {
  return (await publicClient.readContract({
    address: paymaster,
    abi: OxidePaymasterAbi,
    functionName: 'getHash',
    args: [userOp, Number(validUntil), Number(validAfter)],
  } as any)) as Hex;
}

/// Tops up the paymaster's EntryPoint deposit (gas the EntryPoint draws on to sponsor ops). Plain ETH
/// sent to the paymaster address would not count — it must live in the EntryPoint's deposit ledger.
export async function fundPaymaster(
  walletClient: WalletClient,
  publicClient: PublicClient,
  paymaster: Address,
  value: bigint,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: paymaster,
    abi: OxidePaymasterAbi,
    functionName: 'deposit',
    value,
  } as any);
  await publicClient.waitForTransactionReceipt({ hash });
}

/// The paymaster's EntryPoint deposit balance.
export async function getPaymasterDeposit(
  publicClient: PublicClient,
  entryPoint: Address,
  paymaster: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: entryPoint,
    abi: EntryPointAbi,
    functionName: 'balanceOf',
    args: [paymaster],
  } as any)) as bigint;
}
