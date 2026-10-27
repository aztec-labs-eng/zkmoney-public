import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { describe, expect, it, jest } from '@jest/globals';
import type { Account, Chain, PublicActions, Transport, WalletClient } from 'viem';

import { OxidePortalContract } from './oxide_portal.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

function setup() {
  const estimateContractGas = jest.fn((_request: unknown) => Promise.resolve(100_000n));
  const writeContract = jest.fn((_request: unknown) => Promise.resolve('0x1234' as const));
  const client = {
    account: { address: ADDRESS, type: 'json-rpc' },
    estimateContractGas,
    writeContract,
  } as unknown as WalletClient<Transport, Chain, Account> & PublicActions;
  const portal = new OxidePortalContract(client, ADDRESS);
  return { portal, estimateContractGas, writeContract };
}

describe('OxidePortal write gas', () => {
  it('pads the deposit estimate by half', async () => {
    const { portal, estimateContractGas, writeContract } = setup();
    const recipientCommitment = new Fr(7n);
    await expect(portal.deposit(recipientCommitment, 5n)).resolves.toEqual({
      txHash: '0x1234',
      receipt: undefined,
      event: undefined,
    });
    const encoded = [recipientCommitment.toString(), 5n];
    expect(estimateContractGas).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'deposit',
        args: encoded,
        account: expect.objectContaining({ address: ADDRESS }),
      }),
    );
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'deposit', args: encoded, gas: 150_000n }),
    );
  });

  it('uses an explicit gas limit without estimating', async () => {
    const { portal, estimateContractGas, writeContract } = setup();
    await portal.freeze({ gas: 250_000n });
    expect(estimateContractGas).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'freeze', gas: 250_000n }));
  });
});
