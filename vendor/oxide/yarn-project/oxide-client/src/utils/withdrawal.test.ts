import { PermanentError } from '../errors.js';
import { type WithdrawInitiation, fromInitiation } from './withdrawal.js';

describe('fromInitiation permanent errors', () => {
  it('throws PermanentError when the withdrawal index is out of range', async () => {
    const initiation = {
      tokenOperation: { withdrawals: [] },
      signOutput: { withdrawalSignatures: [] },
    } as unknown as WithdrawInitiation;
    await expect(fromInitiation(initiation, 0)).rejects.toBeInstanceOf(PermanentError);
  });

  it('throws PermanentError when the withdrawal signature is missing at the index', async () => {
    const initiation = {
      tokenOperation: { withdrawals: [{}] },
      signOutput: { withdrawalSignatures: [] },
    } as unknown as WithdrawInitiation;
    await expect(fromInitiation(initiation, 0)).rejects.toBeInstanceOf(PermanentError);
  });
});
