import { toBufferBE } from '@aztec/foundation/bigint-buffer';
import { keccak256 } from '@aztec/foundation/crypto/keccak';
import type { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';

export interface SipaAddressInputs {
  sipaFactory: EthAddress;
  implementation: EthAddress;
  intentHash: Buffer;
  recoveryCommitment: Fr;
  rollupVersion: bigint;
  resweepable: boolean;
}

export function computeSIPAAddress(inputs: SipaAddressInputs): EthAddress {
  if (inputs.recoveryCommitment.toBigInt() >= 1n << 248n) {
    throw new Error('SIPA recovery commitment must fit in 248 bits.');
  }
  if (inputs.intentHash.length !== 32 || inputs.rollupVersion < 0n || inputs.rollupVersion >= 2n ** 256n) {
    throw new Error('SIPA identity requires a 32-byte intent hash and a uint256 rollup version.');
  }
  const args = Buffer.concat([
    inputs.intentHash,
    inputs.recoveryCommitment.toBuffer(),
    toBufferBE(inputs.rollupVersion, 32),
    toBufferBE(inputs.resweepable ? 1n : 0n, 32),
  ]);
  const runtimeLength = args.length + 0x2d;
  const initCode = Buffer.concat([
    Buffer.from([0x61, (runtimeLength >> 8) & 0xff, runtimeLength & 0xff]),
    Buffer.from('3d81600a3d39f3363d3d373d3d3d363d73', 'hex'),
    inputs.implementation.toBuffer(),
    Buffer.from('5af43d82803e903d91602b57fd5bf3', 'hex'),
    args,
  ]);
  return new EthAddress(
    keccak256(
      Buffer.concat([Buffer.from([0xff]), inputs.sipaFactory.toBuffer(), Buffer.alloc(32), keccak256(initCode)]),
    ).subarray(12),
  );
}
