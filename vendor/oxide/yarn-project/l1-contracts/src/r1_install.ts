import { type Address, type Hex, size, zeroHash } from 'viem';

import { type R1PublicKeyArg, encodeAddAuthKey } from './account.js';
import { type PackedUserOperation, packU128LimbsToBytes32 } from './entrypoint.js';

// Mirror `RegistrationController.R1_INSTALL_*`.
export const R1_INSTALL_VERIFICATION_GAS = 50_000n;
export const R1_INSTALL_CALL_GAS_BASE = 85_000n;
export const R1_INSTALL_CALL_GAS_PER_WORD = 30_000n;

// Metadata of 32 bytes or more also writes a length word.
export function r1InstallCallGas(metadata: Hex): bigint {
  const length = size(metadata);
  const words = Math.ceil(length / 32) + (length >= 32 ? 1 : 0);
  return R1_INSTALL_CALL_GAS_BASE + R1_INSTALL_CALL_GAS_PER_WORD * BigInt(words);
}

/// The unsigned UserOp the RegistrationController bundles to install `key` on `owner`. The bootstrap key signs
/// the EntryPoint's hash of it; any other field value fails the sweep with `AA24 signature error`.
export function buildR1InstallUserOp(
  owner: Address,
  nonce: bigint,
  key: R1PublicKeyArg,
  metadata: Hex,
): PackedUserOperation {
  return {
    sender: owner,
    nonce,
    initCode: '0x',
    callData: encodeAddAuthKey(key, metadata),
    accountGasLimits: packU128LimbsToBytes32(R1_INSTALL_VERIFICATION_GAS, r1InstallCallGas(metadata)),
    preVerificationGas: 0n,
    gasFees: zeroHash,
    paymasterAndData: '0x',
    signature: '0x',
  };
}
