import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';

import { decodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal_executor.js';

import { describe, expect, it } from '@jest/globals';

import { buildPlainWithdrawal, readPlainWithdrawalFee } from './plain_withdrawal_executor.js';

describe('buildPlainWithdrawal', () => {
  it('encodes the recipient and relayer tip into the user payload', async () => {
    const recipient = EthAddress.random();
    const executor = EthAddress.random();
    const operation = buildPlainWithdrawal({
      from: await AztecAddress.random(),
      executor: { address: executor, fee: 0n },
      recipient,
      relayerTip: 7n,
      amount: 100n,
      proverTip: 3n,
    });
    expect(operation.executor.equals(executor)).toBe(true);
    expect(decodePlainWithdrawalPayload(operation.userPayload)).toEqual({ recipient, relayerTip: 7n });
  });

  it('passes the recovery memo to the operation', async () => {
    const recoveryMemo = Buffer.from('escrow args');
    const operation = buildPlainWithdrawal({
      from: await AztecAddress.random(),
      executor: { address: EthAddress.random(), fee: 0n },
      recipient: EthAddress.random(),
      relayerTip: 0n,
      amount: 100n,
      proverTip: 0n,
      recoveryMemo,
    });
    expect(operation.recoveryMemo).toEqual(recoveryMemo);
  });

  it('rejects a zero recipient', async () => {
    const from = await AztecAddress.random();
    expect(() =>
      buildPlainWithdrawal({
        from,
        executor: { address: EthAddress.random(), fee: 0n },
        recipient: EthAddress.ZERO,
        relayerTip: 0n,
        amount: 100n,
        proverTip: 0n,
      }),
    ).toThrow(/must not be zero/);
  });

  it('accepts a relayer tip equal to the executor amount', async () => {
    const from = await AztecAddress.random();
    expect(() =>
      buildPlainWithdrawal({
        from,
        executor: { address: EthAddress.random(), fee: 0n },
        recipient: EthAddress.random(),
        relayerTip: 90n,
        amount: 100n,
        proverTip: 10n,
      }),
    ).not.toThrow();
  });

  it('rejects a relayer tip more than the executor amount', async () => {
    const from = await AztecAddress.random();
    expect(() =>
      buildPlainWithdrawal({
        from,
        executor: { address: EthAddress.random(), fee: 0n },
        recipient: EthAddress.random(),
        relayerTip: 91n,
        amount: 100n,
        proverTip: 10n,
      }),
    ).toThrow(/exceeds the amount after the fee/);
  });

  it('rejects a relayer tip more than the executor amount after the fee', async () => {
    const from = await AztecAddress.random();
    expect(() =>
      buildPlainWithdrawal({
        from,
        executor: { address: EthAddress.random(), fee: 5n },
        recipient: EthAddress.random(),
        relayerTip: 86n,
        amount: 100n,
        proverTip: 10n,
      }),
    ).toThrow(/exceeds the amount after the fee/);
  });
});

describe('readPlainWithdrawalFee', () => {
  it("reads the executor's FEE", async () => {
    const executor = EthAddress.random();
    const reads: unknown[] = [];
    const client = {
      readContract: (args: unknown) => {
        reads.push(args);
        return Promise.resolve(5n);
      },
    };
    await expect(readPlainWithdrawalFee(client as never, executor)).resolves.toBe(5n);
    expect(reads).toEqual([expect.objectContaining({ address: executor.toString(), functionName: 'FEE' })]);
  });
});
