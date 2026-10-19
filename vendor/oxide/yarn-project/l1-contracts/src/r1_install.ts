import { type Address, type Hex, size, zeroHash } from 'viem';

import { type R1PublicKeyArg, encodeAddAuthKey } from './account.js';
import { type PackedUserOperation, packU128LimbsToBytes32 } from './entrypoint.js';

// Mirror `RegistrationController.R1_INSTALL_*`.
export const R1_INSTALL_VERIFICATION_GAS = 155_000n;
export const R1_INSTALL_CALL_GAS_BASE = 390_000n;
export const R1_INSTALL_CALL_GAS_PER_WORD = 145_000n;

/** The gas limits a RegistrationController puts in the R1 install UserOp. */
export interface R1InstallGas {
  verification: bigint;
  callBase: bigint;
  callPerWord: bigint;
}

/** The limits of a controller built from this source. A controller from an earlier build can use other limits; read
 *  them with `readR1InstallGas`. */
export const R1_INSTALL_GAS: R1InstallGas = {
  verification: R1_INSTALL_VERIFICATION_GAS,
  callBase: R1_INSTALL_CALL_GAS_BASE,
  callPerWord: R1_INSTALL_CALL_GAS_PER_WORD,
};

// Metadata of 32 bytes or more also writes a length word.
export function r1InstallCallGas(metadata: Hex, gas: R1InstallGas = R1_INSTALL_GAS): bigint {
  const length = size(metadata);
  const words = Math.ceil(length / 32) + (length >= 32 ? 1 : 0);
  return gas.callBase + gas.callPerWord * BigInt(words);
}

/// The unsigned UserOp the RegistrationController bundles to install `key` on `owner`. The bootstrap key signs
/// the EntryPoint's hash of it; any other field value fails the sweep with `AA24 signature error`. `gas` must be
/// the limits of the controller that does the sweep.
export function buildR1InstallUserOp(
  owner: Address,
  nonce: bigint,
  key: R1PublicKeyArg,
  metadata: Hex,
  gas: R1InstallGas = R1_INSTALL_GAS,
): PackedUserOperation {
  return {
    sender: owner,
    nonce,
    initCode: '0x',
    callData: encodeAddAuthKey(key, metadata),
    accountGasLimits: packU128LimbsToBytes32(gas.verification, r1InstallCallGas(metadata, gas)),
    preVerificationGas: 0n,
    gasFees: zeroHash,
    paymasterAndData: '0x',
    signature: '0x',
  };
}
