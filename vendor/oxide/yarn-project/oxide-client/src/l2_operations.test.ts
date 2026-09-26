import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';

import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';

import { describe, expect, it, jest } from '@jest/globals';

import { assertPlainWithdrawals, submit } from './l2_operations.js';

describe('submit plain withdrawal validation', () => {
  it('rejects a zero recipient before it simulates or requests a TEE signature', async () => {
    const from = await AztecAddress.random();
    const executor = EthAddress.random();
    const signer = { signTokenOperation: jest.fn() } as any;
    const wallet = { simulateTx: jest.fn() } as any;
    const zeroRecipientPayload = Buffer.alloc(64);

    await expect(
      submit({ wallet, chain: {} as any }, from, {
        contract: {} as any,
        signer,
        operations: [
          {
            kind: 'withdraw',
            from,
            executor,
            userPayload: zeroRecipientPayload,
            amount: 100n,
            proverTip: 0n,
          },
        ],
        plainWithdrawalExecutor: executor,
        fpcFundingCut: 0n,
      }),
    ).rejects.toThrow(/must not be zero/);

    expect(wallet.simulateTx).not.toHaveBeenCalled();
    expect(signer.signTokenOperation).not.toHaveBeenCalled();
  });
});

describe('assertPlainWithdrawals', () => {
  const executor = EthAddress.random();

  function plainWithdrawal(relayerTip: bigint, withdrawalExecutor = executor) {
    return {
      executor: withdrawalExecutor,
      userPayload: encodePlainWithdrawalPayload({ recipient: EthAddress.random(), relayerTip }),
      amount: 100n,
      proverTip: 10n,
    };
  }

  it('accepts a relayer tip equal to the executor amount', () => {
    expect(() =>
      assertPlainWithdrawals([plainWithdrawal(80n)], { plainWithdrawalExecutor: executor, fpcFundingCut: 10n }),
    ).not.toThrow();
  });

  it('rejects a relayer tip more than the executor amount', () => {
    expect(() =>
      assertPlainWithdrawals([plainWithdrawal(81n)], { plainWithdrawalExecutor: executor, fpcFundingCut: 10n }),
    ).toThrow(/exceeds executor amount/);
  });

  it('does not take the funding cut from a frozen portal', () => {
    expect(() =>
      assertPlainWithdrawals([plainWithdrawal(90n)], {
        plainWithdrawalExecutor: executor,
        fpcFundingCut: 10n,
        portalFrozen: true,
      }),
    ).not.toThrow();
  });

  it('requires the funding cut for a plain withdrawal', () => {
    expect(() => assertPlainWithdrawals([plainWithdrawal(0n)], { plainWithdrawalExecutor: executor })).toThrow(
      /funding cut/,
    );
  });

  it('does not check a withdrawal through a different executor', () => {
    expect(() =>
      assertPlainWithdrawals([plainWithdrawal(1_000n, EthAddress.random())], { plainWithdrawalExecutor: executor }),
    ).not.toThrow();
  });
});
