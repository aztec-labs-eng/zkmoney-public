import { Buffer32 } from '@aztec/foundation/buffer';
import { Fr } from '@aztec/foundation/curves/bn254';
import { TxHash } from '@aztec/stdlib/tx';

import { describe, expect, it } from '@jest/globals';

import { computeWithdrawalId } from './published_withdrawal.js';

describe('computeWithdrawalId', () => {
  it('is sha256 of the creation tx hash followed by the message hash, as the TEE signer computes it', () => {
    const txHash = TxHash.fromString('0x0000000000000000000000000000000000000000000000000000000000000001');
    const messageHash = Fr.fromHexString('0x0000000000000000000000000000000000000000000000000000000000000abc');

    expect(computeWithdrawalId(txHash, messageHash)).toEqual(
      Buffer32.fromString('0xfbf2f807ea0aa86bdd4fa805d6fe419c8d9795a9e4db6479c5dd236aa94ca466'),
    );
  });
});
