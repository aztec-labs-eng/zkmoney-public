import { Buffer32 } from '@aztec-labs/foundation/buffer';

import { describe, expect, it, jest } from '@jest/globals';
import type { Account, Chain, PublicActions, Transport, WalletClient } from 'viem';

import { TeeRegistryContract } from './tee_registry.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

function setup() {
  const estimateContractGas = jest.fn((_request: unknown) => Promise.resolve(100_000n));
  const writeContract = jest.fn((_request: unknown) => Promise.resolve('0x1234' as const));
  const client = {
    account: { address: ADDRESS, type: 'json-rpc' },
    estimateContractGas,
    writeContract,
  } as unknown as WalletClient<Transport, Chain, Account> & PublicActions;
  const registry = new TeeRegistryContract(client, ADDRESS);
  const keys = ['11', '22', '33', '44'].map(b => `0x${b.repeat(32)}`);
  const [pubKeyX, pubKeyY, encPubKeyX, encPubKeyY] = keys.map(k => Buffer32.fromString(k));
  const args = [Buffer.from('aa', 'hex'), Buffer.from('bb', 'hex'), pubKeyX, pubKeyY, encPubKeyX, encPubKeyY] as const;
  const encoded = ['0xaa', '0xbb', ...keys];
  return { registry, args, encoded, estimateContractGas, writeContract };
}

describe('TEE registration gas', () => {
  it('pads the estimate by half', async () => {
    const { registry, args, encoded, estimateContractGas, writeContract } = setup();
    await expect(registry.registerTee(...args)).resolves.toEqual({ txHash: '0x1234', receipt: undefined });
    expect(estimateContractGas).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'registerTee',
        args: encoded,
        account: expect.objectContaining({ address: ADDRESS }),
      }),
    );
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'registerTee', args: encoded, gas: 150_000n }),
    );
  });

  it('uses an explicit gas limit without estimating', async () => {
    const { registry, args, estimateContractGas, writeContract } = setup();
    await registry.registerTee(...args, { gas: 250_000n });
    expect(estimateContractGas).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 250_000n }));
  });
});
