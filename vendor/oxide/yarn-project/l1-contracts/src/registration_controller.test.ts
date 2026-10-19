import { describe, expect, it, jest } from '@jest/globals';
import type { PublicClient, WalletClient } from 'viem';

import {
  addBeneficiary,
  readIsBeneficiary,
  readR1InstallGas,
  readRegistrationFee,
  readRegistrationMin,
} from './registration_controller.js';

function fakeClients(status: 'success' | 'reverted') {
  const writeContract = jest.fn((_request: unknown) => Promise.resolve('0xhash'));
  const waitForTransactionReceipt = jest.fn((_request: unknown) => Promise.resolve({ status, blockNumber: 7n }));
  const getBlockNumber = jest.fn(() => Promise.resolve(7n));
  return {
    wallet: { writeContract } as unknown as WalletClient,
    publicClient: { waitForTransactionReceipt, getBlockNumber } as unknown as PublicClient,
    writeContract,
  };
}

describe('RegistrationController beneficiaries', () => {
  const CONTROLLER = '0xc32fd88cbd0f3908ba4756686707d5dedbd791c5';
  const FUNDER = '0xddf9b46c9f6337bf6e19c3f8eea8e07b1b74d68a';

  it('reads REGISTRATION_FEE and REGISTRATION_MIN off the controller', async () => {
    const readContract = jest.fn((request: { functionName: string }) =>
      Promise.resolve(request.functionName === 'REGISTRATION_FEE' ? 4_500_000n : 1_000_000n),
    );
    const publicClient = { readContract } as unknown as PublicClient;
    await expect(readRegistrationFee(publicClient, CONTROLLER)).resolves.toBe(4_500_000n);
    await expect(readRegistrationMin(publicClient, CONTROLLER)).resolves.toBe(1_000_000n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: CONTROLLER, functionName: 'REGISTRATION_MIN' }),
    );
  });

  it('reads the R1 install gas limits off the controller', async () => {
    const limits: Record<string, bigint> = {
      R1_INSTALL_VERIFICATION_GAS: 50_000n,
      R1_INSTALL_CALL_GAS_BASE: 85_000n,
      R1_INSTALL_CALL_GAS_PER_WORD: 30_000n,
    };
    const readContract = jest.fn((request: { address: string; functionName: string }) =>
      Promise.resolve(limits[request.functionName]),
    );
    const publicClient = { readContract } as unknown as PublicClient;
    await expect(readR1InstallGas(publicClient, CONTROLLER)).resolves.toEqual({
      verification: 50_000n,
      callBase: 85_000n,
      callPerWord: 30_000n,
    });
    expect(readContract.mock.calls.every(([request]) => request.address === CONTROLLER)).toBe(true);
  });

  it('reads isBeneficiary off the controller', async () => {
    const readContract = jest.fn((_request: unknown) => Promise.resolve(true));
    const publicClient = { readContract } as unknown as PublicClient;
    await expect(readIsBeneficiary(publicClient, CONTROLLER, FUNDER)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: CONTROLLER, functionName: 'isBeneficiary', args: [FUNDER] }),
    );
  });

  it('writes addBeneficiary on the controller and waits for the receipt', async () => {
    const { wallet, publicClient, writeContract } = fakeClients('success');
    await addBeneficiary(wallet, publicClient, CONTROLLER, FUNDER);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: CONTROLLER, functionName: 'addBeneficiary', args: [FUNDER] }),
    );
  });

  it('throws when addBeneficiary reverted', async () => {
    const { wallet, publicClient } = fakeClients('reverted');
    await expect(addBeneficiary(wallet, publicClient, CONTROLLER, FUNDER)).rejects.toThrow(/reverted in block 7/);
  });
});
