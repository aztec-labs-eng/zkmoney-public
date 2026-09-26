import { EthAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';

import {
  type BroadcastL1Operation,
  L1OperationCondition,
  L1_OPERATION_BROADCAST_TIERS,
  MAX_L1_OPERATION_CALLDATA_BYTES,
} from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it, jest } from '@jest/globals';

import {
  type L1OperationBroadcaster,
  type L1OperationPairBroadcaster,
  broadcastL1Operation,
  broadcastL1OperationPair,
} from './broadcaster_calls.js';

type TierMethodName = keyof L1OperationBroadcaster['methods'];
type TierMethod = L1OperationBroadcaster['methods'][TierMethodName];
type PairMethod = L1OperationPairBroadcaster['methods']['broadcast_l1_operation_pair_2k'];

const INTERACTION = {} as ContractFunctionInteraction;

/** A hand-written Broadcaster slice with one mock per size tier. */
function fakeBroadcaster() {
  const methods = Object.fromEntries(
    L1_OPERATION_BROADCAST_TIERS.map(tier => [tier.method, jest.fn<TierMethod>(() => INTERACTION)]),
  ) as Record<TierMethodName, jest.Mock<TierMethod>>;
  const broadcaster: L1OperationBroadcaster = { methods };
  return { broadcaster, methods };
}

/** A hand-written Broadcaster slice with the paired 2k method. */
function fakePairBroadcaster() {
  const build = jest.fn<PairMethod>(() => INTERACTION);
  const broadcaster: L1OperationPairBroadcaster = { methods: { ['broadcast_l1_operation_pair_2k']: build } };
  return { broadcaster, build };
}

function operation(calldata: Buffer, condition = L1OperationCondition.immediate()): BroadcastL1Operation {
  return { target: EthAddress.random(), payoutToken: EthAddress.random(), calldata, condition };
}

/** The field of a 31-byte big-endian chunk: one zero byte, then the chunk, then zero padding. */
function chunkField(chunk: Buffer): Fr {
  const buf = Buffer.alloc(32);
  chunk.copy(buf, 1);
  return Fr.fromBuffer(buf);
}

describe('broadcastL1Operation', () => {
  it('calls the smallest tier that fits the calldata, at both edges of each tier', () => {
    L1_OPERATION_BROADCAST_TIERS.forEach((tier, i) => {
      const smallest = i === 0 ? 0 : L1_OPERATION_BROADCAST_TIERS[i - 1].fields * 31 + 1;
      const largest = Math.min(tier.fields * 31, MAX_L1_OPERATION_CALLDATA_BYTES);
      for (const bytesLen of [smallest, largest]) {
        const { broadcaster, methods } = fakeBroadcaster();
        const op = operation(
          Buffer.alloc(bytesLen, 0xab),
          L1OperationCondition.balance(EthAddress.random(), EthAddress.random()),
        );

        expect(broadcastL1Operation(broadcaster, op)).toBe(INTERACTION);

        for (const other of L1_OPERATION_BROADCAST_TIERS) {
          expect(methods[other.method]).toHaveBeenCalledTimes(other.method === tier.method ? 1 : 0);
        }
        const [target, payoutToken, len, fields, condition] = methods[tier.method].mock.calls[0];
        expect(target).toBe(op.target);
        expect(payoutToken).toBe(op.payoutToken);
        expect(len).toBe(bytesLen);
        expect(fields).toHaveLength(tier.fields);
        expect(condition).toBe(op.condition);
      }
    });
  });

  it('packs the calldata into big-endian 31-byte chunks and pads the tier with zero fields', () => {
    const { broadcaster, methods } = fakeBroadcaster();
    const calldata = Buffer.concat([Buffer.alloc(31, 0x11), Buffer.from('1234', 'hex')]);

    broadcastL1Operation(broadcaster, operation(calldata));

    const fields = methods.broadcast_l1_operation_2k.mock.calls[0][3];
    expect(fields[0]).toEqual(chunkField(Buffer.alloc(31, 0x11)));
    expect(fields[1]).toEqual(new Fr(0x1234n << 232n));
    expect(fields.slice(2)).toEqual(Array(L1_OPERATION_BROADCAST_TIERS[0].fields - 2).fill(Fr.ZERO));
  });

  it('rejects calldata over the Ethereum maximum before it builds a call', () => {
    const { broadcaster, methods } = fakeBroadcaster();

    expect(() =>
      broadcastL1Operation(broadcaster, operation(Buffer.alloc(MAX_L1_OPERATION_CALLDATA_BYTES + 1))),
    ).toThrow(`(max ${MAX_L1_OPERATION_CALLDATA_BYTES})`);

    for (const tier of L1_OPERATION_BROADCAST_TIERS) {
      expect(methods[tier.method]).not.toHaveBeenCalled();
    }
  });
});

describe('broadcastL1OperationPair', () => {
  it('packs both operations into the 2k tier and keeps their order', () => {
    const { broadcaster, build } = fakePairBroadcaster();
    const withdrawal = operation(Buffer.alloc(67 * 31, 0xab), L1OperationCondition.messageInOutbox());
    const swap = operation(
      Buffer.from('1234', 'hex'),
      L1OperationCondition.balance(withdrawal.payoutToken, EthAddress.random()),
    );

    expect(broadcastL1OperationPair(broadcaster, [withdrawal, swap])).toBe(INTERACTION);

    expect(build).toHaveBeenCalledTimes(1);
    const [targets, payoutTokens, bytesLens, fields, conditions] = build.mock.calls[0];
    expect(targets).toEqual([withdrawal.target, swap.target]);
    expect(payoutTokens).toEqual([withdrawal.payoutToken, swap.payoutToken]);
    expect(bytesLens).toEqual([67 * 31, 2]);
    expect(fields.map(f => f.length)).toEqual([67, 67]);
    expect(fields[0]).toEqual(Array(67).fill(chunkField(Buffer.alloc(31, 0xab))));
    expect(fields[1][0]).toEqual(new Fr(0x1234n << 232n));
    expect(fields[1].slice(1)).toEqual(Array(66).fill(Fr.ZERO));
    expect(conditions).toEqual([withdrawal.condition, swap.condition]);
  });

  it('rejects an operation over the 2k tier before it builds a call', () => {
    const { broadcaster, build } = fakePairBroadcaster();
    const small = operation(Buffer.from('1234', 'hex'));
    const oversized = operation(Buffer.alloc(67 * 31 + 1));

    expect(() => broadcastL1OperationPair(broadcaster, [small, oversized])).toThrow('over the 67-field capacity');
    expect(build).not.toHaveBeenCalled();
  });

  it('rejects a pair that does not hold exactly two operations', () => {
    const { broadcaster, build } = fakePairBroadcaster();
    const single = [operation(Buffer.from('1234', 'hex'))] as unknown as [BroadcastL1Operation, BroadcastL1Operation];

    expect(() => broadcastL1OperationPair(broadcaster, single)).toThrow('exactly two operations');
    expect(build).not.toHaveBeenCalled();
  });
});
