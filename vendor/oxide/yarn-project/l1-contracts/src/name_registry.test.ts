import { describe, expect, it, jest } from '@jest/globals';
import type { PublicClient, WalletClient } from 'viem';

import { updateDomainOwner } from './name_registry.js';

const REGISTRY = '0x468424dae502355ea0b7555b009562e51703ddc4';
const NEW_OWNER = '0x768001056e4d89fd45bf74df3d91809f9beb1ee1';

function fakeClients(status: 'success' | 'reverted') {
  const writeContract = jest.fn((_request: unknown) => Promise.resolve('0xhash'));
  const waitForTransactionReceipt = jest.fn((_request: unknown) => Promise.resolve({ status, blockNumber: 7n }));
  return {
    wallet: { writeContract } as unknown as WalletClient,
    publicClient: { waitForTransactionReceipt } as unknown as PublicClient,
    writeContract,
  };
}

describe('updateDomainOwner', () => {
  it('writes NameRegistry.updateDomainOwner with the new owner', async () => {
    const { wallet, publicClient, writeContract } = fakeClients('success');
    await updateDomainOwner(wallet, publicClient, REGISTRY, NEW_OWNER);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: REGISTRY, functionName: 'updateDomainOwner', args: [NEW_OWNER] }),
    );
  });

  it('throws when the tx reverted', async () => {
    const { wallet, publicClient } = fakeClients('reverted');
    await expect(updateDomainOwner(wallet, publicClient, REGISTRY, NEW_OWNER)).rejects.toThrow(/reverted in block 7/);
  });
});
