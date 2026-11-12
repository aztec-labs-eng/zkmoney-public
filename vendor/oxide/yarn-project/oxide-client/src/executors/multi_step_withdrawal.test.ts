import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';

import { decodeMultiStepPayload } from '@oxide/l1-contracts/multi_step/index.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import { describe, expect, it } from '@jest/globals';
import { zeroAddress } from 'viem';

import {
  type MultiStepWithdrawalArgs,
  buildMultiStepWithdrawal,
  checkedMultiStepRemainder,
} from './multi_step_withdrawal.js';

describe('buildMultiStepWithdrawal', () => {
  it('puts the tip, the route and the recovery commitment in the user payload', async () => {
    const args = await multiStepArgs();

    const { operation, recoverySalt } = buildMultiStepWithdrawal(args);

    expect(operation.kind).toBe('withdraw');
    expect(operation.executor.equals(args.executor)).toBe(true);
    expect(decodeMultiStepPayload(operation.userPayload)).toEqual({
      ...args.compiledRoute,
      relayerTip: args.relayerTip,
      recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString(),
    });
  });

  it('uses the given recovery salt, else a fresh one', async () => {
    const args = await multiStepArgs();
    const recoverySalt = Fr.random();

    expect(buildMultiStepWithdrawal({ ...args, recoverySalt }).recoverySalt).toEqual(recoverySalt);
    expect(buildMultiStepWithdrawal(args).recoverySalt.equals(buildMultiStepWithdrawal(args).recoverySalt)).toBe(false);
  });

  it('rejects a zero recovery account', async () => {
    const args = await multiStepArgs();

    expect(() => buildMultiStepWithdrawal({ ...args, recoveryAccount: EthAddress.ZERO })).toThrow(
      /zero recoveryAccount/,
    );
  });

  it('pays the fee pool cut before the fixed lanes', async () => {
    const args = await multiStepArgs();
    const beneficiary = EthAddress.random();

    const { operation } = buildMultiStepWithdrawal({ ...args, feePoolCut: { amount: 15n, beneficiary } });

    expect(decodeMultiStepPayload(operation.userPayload).transfers).toEqual([
      { amount: 15n, recipient: beneficiary.toChecksumString() },
      ...args.compiledRoute.transfers,
    ]);
  });

  it('counts the fee pool cut against the remainder lane', async () => {
    const args = await multiStepArgs();
    const feePoolCut = { amount: 15n, beneficiary: EthAddress.random() };

    expect(() => buildMultiStepWithdrawal({ ...args, feePoolCut, relayerTip: 950n })).toThrow(/\(995\) must be below/);
  });

  it('accepts a route with no remainder lane whose relayer tip and fixed lanes spend all that the prover tip leaves', async () => {
    const args = await multiStepArgs();
    const compiledRoute = { ...args.compiledRoute, remainderRecipient: undefined };

    const { operation } = buildMultiStepWithdrawal({ ...args, compiledRoute, relayerTip: 965n });

    expect(decodeMultiStepPayload(operation.userPayload).remainderRecipient).toBe(zeroAddress);
  });

  it('rejects a route with no remainder lane that leaves something or spends too much', async () => {
    const args = await multiStepArgs();
    const compiledRoute = { ...args.compiledRoute, remainderRecipient: undefined };

    expect(() => buildMultiStepWithdrawal({ ...args, compiledRoute, relayerTip: 964n })).toThrow(
      /\(994\) must equal amount - proverTip \(995\)/,
    );
    expect(() => buildMultiStepWithdrawal({ ...args, compiledRoute, relayerTip: 966n })).toThrow(
      /\(996\) must equal amount - proverTip \(995\)/,
    );
  });

  it('rejects a fee pool cut without a beneficiary', async () => {
    const args = await multiStepArgs();

    expect(() =>
      buildMultiStepWithdrawal({ ...args, feePoolCut: { amount: 1n, beneficiary: EthAddress.ZERO } }),
    ).toThrow(/needs a beneficiary/);
  });
});

describe('checkedMultiStepRemainder', () => {
  it('is the amount less the prover tip, the relayer tip, the fee pool cut and the fixed lanes', () => {
    expect(
      checkedMultiStepRemainder({ amount: 1_000n, proverTip: 5n, relayerTip: 20n, feePoolCut: 15n, fixed: [30n] }),
    ).toBe(930n);
    expect(() =>
      checkedMultiStepRemainder({ amount: 1_000n, proverTip: 5n, relayerTip: 950n, feePoolCut: 15n, fixed: [30n] }),
    ).toThrow(/fixed lanes \(995\) must be below/);
  });
});

async function multiStepArgs(): Promise<MultiStepWithdrawalArgs> {
  return {
    from: await AztecAddress.random(),
    executor: EthAddress.random(),
    relayerTip: 20n,
    feePoolCut: { amount: 0n, beneficiary: EthAddress.ZERO },
    compiledRoute: {
      remainderRecipient: EthAddress.random().toChecksumString(),
      transfers: [{ amount: 30n, recipient: EthAddress.random().toChecksumString() }],
      steps: [{ target: EthAddress.random().toChecksumString(), data: '0x1234' }],
    },
    amount: 1_000n,
    proverTip: 5n,
    recoveryAccount: EthAddress.random(),
  };
}
