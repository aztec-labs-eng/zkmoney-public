import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';

import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from '@oxide/l1-contracts/deposit_tokens.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';
import {
  StablecoinWithdrawalRoute,
  decodeStablecoinWithdrawalPayload,
  encodeStablecoinWithdrawalPayload,
} from '@oxide/oxide-lib/stablecoin_withdrawal_executor.js';

import { describe, expect, it } from '@jest/globals';
import type { Hex } from 'viem';

import {
  MAX_DAI_FOR_GAS,
  type StablecoinWithdrawalArgs,
  buildStablecoinWithdrawal,
  readStablecoinWithdrawalFee,
} from './stablecoin_withdrawal_executor.js';

describe('buildStablecoinWithdrawal', () => {
  async function args(overrides: Partial<StablecoinWithdrawalArgs> = {}): Promise<StablecoinWithdrawalArgs> {
    return {
      from: await AztecAddress.random(),
      executor: { address: EthAddress.random(), fee: 1n, asset: MAINNET_DAI },
      recipient: EthAddress.random(),
      relayerTip: 7n,
      amount: 100n,
      proverTip: 3n,
      recoveryAccount: EthAddress.random(),
      ...overrides,
    };
  }

  function expectedPayload(
    built: StablecoinWithdrawalArgs,
    recoverySalt: Fr,
    fields: { route: StablecoinWithdrawalRoute; minOut?: bigint; daiForGas?: bigint },
  ): Buffer {
    return encodeStablecoinWithdrawalPayload({
      route: fields.route,
      recipient: built.recipient,
      daiForGas: fields.daiForGas ?? 0n,
      minOut: fields.minOut ?? 0n,
      recoveryCommitment: deriveRecoveryCommitment(recoverySalt, built.recoveryAccount).toString() as Hex,
      relayerTip: built.relayerTip,
    });
  }

  it("pays the portal's asset as is when no output token is given, with a commitment to the recovery account", async () => {
    const built = await args();
    const { operation, recoverySalt } = buildStablecoinWithdrawal(built);

    expect(operation.executor.equals(built.executor.address)).toBe(true);
    expect(operation.userPayload).toEqual(
      expectedPayload(built, recoverySalt, { route: StablecoinWithdrawalRoute.DAI }),
    );
  });

  it('encodes mainnet DAI as the DAI route with no minOut', async () => {
    const built = await args({ outputToken: MAINNET_DAI });
    const { operation, recoverySalt } = buildStablecoinWithdrawal(built);

    expect(operation.userPayload).toEqual(
      expectedPayload(built, recoverySalt, { route: StablecoinWithdrawalRoute.DAI }),
    );
  });

  it.each([
    ['USDC', MAINNET_USDC, StablecoinWithdrawalRoute.USDC],
    ['USDT', MAINNET_USDT, StablecoinWithdrawalRoute.USDT],
  ])('encodes a %s payout with its minOut', async (_, outputToken, route) => {
    const built = await args({ outputToken, minOut: 80n });
    const { operation, recoverySalt } = buildStablecoinWithdrawal(built);

    expect(operation.userPayload).toEqual(expectedPayload(built, recoverySalt, { route, minOut: 80n }));
  });

  it('encodes a gas share of up to 50 DAI', async () => {
    expect(MAX_DAI_FOR_GAS).toBe(50n * 10n ** 18n);
    const built = await args({ amount: 1000n * 10n ** 18n, daiForGas: MAX_DAI_FOR_GAS });
    const { operation, recoverySalt } = buildStablecoinWithdrawal(built);

    expect(operation.userPayload).toEqual(
      expectedPayload(built, recoverySalt, { route: StablecoinWithdrawalRoute.DAI, daiForGas: MAX_DAI_FOR_GAS }),
    );
  });

  it('uses the given recovery salt, else a fresh one for each withdrawal', async () => {
    const recoverySalt = Fr.random();
    expect(buildStablecoinWithdrawal(await args({ recoverySalt })).recoverySalt).toEqual(recoverySalt);

    const built = await args();
    expect(buildStablecoinWithdrawal(built).recoverySalt).not.toEqual(buildStablecoinWithdrawal(built).recoverySalt);
  });

  it('reads back the recipient and the relayer tip', async () => {
    const built = await args();
    const { operation } = buildStablecoinWithdrawal(built);

    expect(decodeStablecoinWithdrawalPayload(operation.userPayload)).toMatchObject({
      recipient: built.recipient,
      relayerTip: 7n,
    });
  });

  it('passes the recovery memo to the operation', async () => {
    const recoveryMemo = Buffer.from('escrow args');
    const { operation } = buildStablecoinWithdrawal(await args({ recoveryMemo }));

    expect(operation.recoveryMemo).toEqual(recoveryMemo);
  });

  it('rejects a zero recipient', async () => {
    const built = await args({ recipient: EthAddress.ZERO });
    expect(() => buildStablecoinWithdrawal(built)).toThrow(/must not be zero/);
  });

  it('rejects a zero recovery account', async () => {
    const built = await args({ recoveryAccount: EthAddress.ZERO });
    expect(() => buildStablecoinWithdrawal(built)).toThrow(/zero recoveryAccount/);
  });

  it('accepts a relayer tip equal to the amount after the fee, and rejects one more', async () => {
    const built = await args({
      executor: { address: EthAddress.random(), fee: 5n, asset: MAINNET_DAI },
      amount: 100n,
      proverTip: 10n,
    });
    expect(() => buildStablecoinWithdrawal({ ...built, relayerTip: 85n })).not.toThrow();
    expect(() => buildStablecoinWithdrawal({ ...built, relayerTip: 86n })).toThrow(/exceeds the amount after the fee/);
  });

  it('rejects a gas share above 50 DAI', async () => {
    const built = await args({ amount: 1000n * 10n ** 18n, daiForGas: MAX_DAI_FOR_GAS + 1n });
    expect(() => buildStablecoinWithdrawal(built)).toThrow(/above the executor maximum/);
  });

  it('rejects a relayer tip and gas share above the amount after the fee', async () => {
    const built = await args();
    expect(() => buildStablecoinWithdrawal({ ...built, daiForGas: 89n })).not.toThrow();
    expect(() => buildStablecoinWithdrawal({ ...built, daiForGas: 90n })).toThrow(/exceed the amount after the fee/);
  });

  it.each([
    ['USDC', MAINNET_USDC],
    ['USDT', MAINNET_USDT],
  ])('rejects a %s payout that the relayer tip and gas share leave with no DAI to swap', async (_, outputToken) => {
    const built = await args({ outputToken, minOut: 80n });
    expect(() => buildStablecoinWithdrawal({ ...built, daiForGas: 88n })).not.toThrow();
    expect(() => buildStablecoinWithdrawal({ ...built, daiForGas: 89n })).toThrow(/no DAI to swap/);
    expect(() => buildStablecoinWithdrawal({ ...built, relayerTip: 96n })).toThrow(/no DAI to swap/);
  });

  it("pays any portal's asset as is", async () => {
    const built = await args({ executor: { address: EthAddress.random(), fee: 1n, asset: EthAddress.random() } });
    const { operation, recoverySalt } = buildStablecoinWithdrawal(built);

    expect(operation.userPayload).toEqual(
      expectedPayload(built, recoverySalt, { route: StablecoinWithdrawalRoute.DAI }),
    );
  });

  it.each([
    ['DAI', { outputToken: MAINNET_DAI }],
    ['USDC', { outputToken: MAINNET_USDC, minOut: 80n }],
    ['USDT', { outputToken: MAINNET_USDT, minOut: 80n }],
    ['ETH for gas', { daiForGas: 1n }],
  ])(
    'rejects %s from an executor that does not pay mainnet DAI, because the executor cannot pay it',
    async (_, fields) => {
      const built = await args({
        executor: { address: EthAddress.random(), fee: 1n, asset: EthAddress.random() },
        ...fields,
      });
      expect(() => buildStablecoinWithdrawal(built)).toThrow(/pays mainnet DAI/);
    },
  );

  it('rejects an output token other than DAI, USDC or USDT', async () => {
    const built = await args({ outputToken: EthAddress.random() });
    expect(() => buildStablecoinWithdrawal(built)).toThrow(/only DAI, USDC or USDT/);
  });

  it.each([
    ['USDC', MAINNET_USDC],
    ['USDT', MAINNET_USDT],
  ])('rejects a zero or missing minOut for %s', async (_, outputToken) => {
    for (const minOut of [0n, undefined]) {
      const built = await args({ outputToken, minOut });
      expect(() => buildStablecoinWithdrawal(built)).toThrow(/zero minOut/);
    }
  });

  it.each([
    ['no output token', undefined],
    ['mainnet DAI', MAINNET_DAI],
  ])('rejects a minOut for %s, which the executor does not read', async (_, outputToken) => {
    const built = await args({ outputToken, minOut: 1n });
    expect(() => buildStablecoinWithdrawal(built)).toThrow(/does not read minOut/);
  });
});

describe('readStablecoinWithdrawalFee', () => {
  it("reads the executor's FEE", async () => {
    const executor = EthAddress.random();
    const reads: unknown[] = [];
    const client = {
      readContract: (args: unknown) => {
        reads.push(args);
        return Promise.resolve(5n);
      },
    };
    await expect(readStablecoinWithdrawalFee(client as never, executor)).resolves.toBe(5n);
    expect(reads).toEqual([expect.objectContaining({ address: executor.toString(), functionName: 'FEE' })]);
  });
});
