import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { MAX_PRIVATE_LOGS_PER_TX } from '@aztec-labs/constants';

import { describe, expect, it } from '@jest/globals';

import { buildPlainWithdrawal } from './executors/plain_withdrawal_executor.js';
import type { WithdrawOperation } from './l2_operations.js';
import {
  assertRecoveryChunksFitInTx,
  buildRecoveryData,
  buildSimulationFinalizationData,
} from './submitted_withdrawal.js';

async function plainWithdrawal(recoveryMemo?: Buffer): Promise<WithdrawOperation> {
  return buildPlainWithdrawal({
    from: await AztecAddress.random(),
    executor: { address: EthAddress.random(), fee: 0n },
    recipient: EthAddress.random(),
    relayerTip: 0n,
    amount: 100n,
    proverTip: 0n,
    recoveryMemo,
  });
}

describe('buildRecoveryData', () => {
  it('pairs each withdrawal with its finalization data and its memo, empty if omitted', async () => {
    const ops = [await plainWithdrawal(Buffer.from('memo')), await plainWithdrawal()];
    const finalizationData = ops.map(buildSimulationFinalizationData);
    expect(buildRecoveryData(ops, finalizationData)).toEqual([
      { finalizationData: finalizationData[0], memo: Buffer.from('memo') },
      { finalizationData: finalizationData[1], memo: Buffer.alloc(0) },
    ]);
  });
});

describe('assertRecoveryChunksFitInTx', () => {
  it('counts the chunks of the memos', async () => {
    // A plain withdrawal has space for a 94-byte memo in its one chunk. A 95-byte memo needs a second chunk.
    const ops = await Promise.all(
      Array.from({ length: MAX_PRIVATE_LOGS_PER_TX / 2 }, () => plainWithdrawal(Buffer.alloc(95))),
    );
    expect(() => assertRecoveryChunksFitInTx(ops)).not.toThrow();
    const overLimit = [...ops, await plainWithdrawal()];
    expect(() => assertRecoveryChunksFitInTx(overLimit)).toThrow(
      `needs ${MAX_PRIVATE_LOGS_PER_TX + 1} private logs, over the ${MAX_PRIVATE_LOGS_PER_TX}-log tx limit`,
    );
  });
});
