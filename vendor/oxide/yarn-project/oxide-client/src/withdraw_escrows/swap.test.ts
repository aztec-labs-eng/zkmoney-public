import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';

import {
  MAX_DAI_FOR_GAS,
  SwapRoute,
  encodeSwapEscrowDeploy,
  predictSwapEscrowAddressLocally,
} from '@oxide/l1-contracts';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { decodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import { describe, expect, it, jest } from '@jest/globals';
import type { PublicClient } from 'viem';

import { type SwapOnWithdrawArgs, assertSwapEscrowDeployable, buildSwapOnWithdraw } from './swap.js';
import { fakeBroadcaster } from './test_helpers.js';

async function swapArgs(): Promise<SwapOnWithdrawArgs> {
  return {
    broadcaster: fakeBroadcaster(),
    swapEscrowFactoryV2: EthAddress.random(),
    dai: EthAddress.random(),
    from: await AztecAddress.random(),
    plainWithdrawalExecutor: EthAddress.random(),
    amount: 1_000n,
    withdrawalRelayerTip: 10n,
    proverTip: 5n,
    fpcFundingCut: 0n,
    route: SwapRoute.USDC,
    l1Recipient: EthAddress.random(),
    recoveryAccount: EthAddress.random(),
    relayerTip: 20n,
  };
}

describe('buildSwapOnWithdraw', () => {
  it('commits the escrow to the nonce and recovery salt that the caller gives', async () => {
    const args = await swapArgs();
    const nonce = Fr.random().toString();
    const recoverySalt = Fr.random();

    const swap = buildSwapOnWithdraw({ ...args, nonce, recoverySalt });

    expect(swap.nonce).toBe(nonce);
    expect(swap.recoverySalt).toEqual(recoverySalt);
    expect(swap.escrowArgs).toEqual({
      route: args.route,
      recipient: args.l1Recipient.toString(),
      daiForGas: 0n,
      minEthForGas: 0n,
      recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString(),
      relayerTip: args.relayerTip,
      nonce,
    });
    expect(swap.escrow).toEqual(
      EthAddress.fromString(predictSwapEscrowAddressLocally(args.swapEscrowFactoryV2.toString(), swap.escrowArgs)),
    );
  });

  it('uses a new nonce and recovery salt for each build when the caller gives neither', async () => {
    const args = await swapArgs();

    const first = buildSwapOnWithdraw(args);
    const second = buildSwapOnWithdraw(args);

    expect(first.nonce).toBe(first.escrowArgs.nonce);
    expect(first.escrowArgs.recoveryCommitment).toBe(
      deriveRecoveryCommitment(first.recoverySalt, args.recoveryAccount).toString(),
    );
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.recoverySalt.equals(second.recoverySalt)).toBe(false);
    expect(first.escrow.equals(second.escrow)).toBe(false);
  });

  it('returns the L1 operation that it broadcasts', async () => {
    const args = await swapArgs();

    const { escrow, escrowArgs, l1Operation } = buildSwapOnWithdraw(args);

    expect(l1Operation.target.equals(args.swapEscrowFactoryV2)).toBe(true);
    expect(l1Operation.payoutToken.equals(args.dai)).toBe(true);
    expect(l1Operation.calldata).toEqual(Buffer.from(encodeSwapEscrowDeploy(escrowArgs).slice(2), 'hex'));
    expect(l1Operation.condition).toEqual(L1OperationCondition.balance(args.dai, escrow));
  });

  it('withdraws to the escrow through the plain withdrawal executor', async () => {
    const args = await swapArgs();

    const { escrow, operation } = buildSwapOnWithdraw(args);

    if (operation.kind !== 'withdraw') {
      throw new Error('expected a withdraw operation');
    }
    expect(operation.executor.equals(args.plainWithdrawalExecutor)).toBe(true);
    const payload = decodePlainWithdrawalPayload(operation.userPayload);
    expect(payload.recipient.equals(escrow)).toBe(true);
    expect(payload.relayerTip).toBe(args.withdrawalRelayerTip);
  });

  it('commits the escrow to daiForGas', async () => {
    const args = await swapArgs();
    const nonce = Fr.random().toString();
    const recoverySalt = Fr.random();

    const withoutGas = buildSwapOnWithdraw({ ...args, nonce, recoverySalt });
    const withGas = buildSwapOnWithdraw({ ...args, nonce, recoverySalt, daiForGas: 100n });

    expect(withGas.escrowArgs).toEqual({ ...withoutGas.escrowArgs, daiForGas: 100n });
    expect(withGas.escrow.equals(withoutGas.escrow)).toBe(false);
  });

  it('commits the escrow to minEthForGas', async () => {
    const args = await swapArgs();
    const nonce = Fr.random().toString();
    const recoverySalt = Fr.random();

    const withoutMin = buildSwapOnWithdraw({ ...args, nonce, recoverySalt, daiForGas: 100n });
    const withMin = buildSwapOnWithdraw({ ...args, nonce, recoverySalt, daiForGas: 100n, minEthForGas: 7n });

    expect(withMin.escrowArgs).toEqual({ ...withoutMin.escrowArgs, minEthForGas: 7n });
    expect(withMin.escrow.equals(withoutMin.escrow)).toBe(false);
  });

  it('rejects a negative minEthForGas', async () => {
    const args = await swapArgs();

    expect(() => buildSwapOnWithdraw({ ...args, daiForGas: 100n, minEthForGas: -1n })).toThrow(/negative/);
  });

  it('rejects minEthForGas without daiForGas', async () => {
    const args = await swapArgs();

    expect(() => buildSwapOnWithdraw({ ...args, minEthForGas: 1n })).toThrow(/daiForGas is 0/);
  });

  it('rejects daiForGas above MAX_DAI_FOR_GAS', async () => {
    const args = await swapArgs();

    expect(() => buildSwapOnWithdraw({ ...args, daiForGas: MAX_DAI_FOR_GAS + 1n })).toThrow(/MAX_DAI_FOR_GAS/);
  });

  it('rejects daiForGas above the escrow funding after relayerTip', async () => {
    const args = await swapArgs();
    const fundingAfterTip = args.amount - args.proverTip - args.withdrawalRelayerTip - args.relayerTip;

    expect(() => buildSwapOnWithdraw({ ...args, daiForGas: fundingAfterTip })).not.toThrow();
    expect(() => buildSwapOnWithdraw({ ...args, daiForGas: fundingAfterTip + 1n })).toThrow(/escrow funding/);
  });

  it('rejects daiForGas on the ETH route', async () => {
    const args = await swapArgs();

    expect(() => buildSwapOnWithdraw({ ...args, route: SwapRoute.ETH, daiForGas: 1n })).toThrow(/ETH route/);
  });

  it('rejects the zero address as the L1 recipient', async () => {
    const args = await swapArgs();

    expect(() => buildSwapOnWithdraw({ ...args, route: SwapRoute.DAI, l1Recipient: EthAddress.ZERO })).toThrow(
      /zero address/,
    );
  });
});

describe('assertSwapEscrowDeployable', () => {
  function clientReturning(readContract: (params: unknown) => Promise<unknown>) {
    const fn = jest.fn(readContract);
    return { fn, client: { readContract: fn } as unknown as Pick<PublicClient, 'readContract'> };
  }

  it('asks the swap factory for the escrow address and accepts a match', async () => {
    const swap = buildSwapOnWithdraw(await swapArgs());
    const { fn, client } = clientReturning(() => Promise.resolve(swap.escrow.toString()));

    await expect(assertSwapEscrowDeployable(client, swap)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({
        address: swap.l1Operation.target.toString(),
        functionName: 'predictEscrowAddress',
        args: [swap.escrowArgs],
      }),
    );
  });

  it('throws when the factory reverts, as a factory with the older layout does', async () => {
    const swap = buildSwapOnWithdraw(await swapArgs());
    const { client } = clientReturning(() => Promise.reject(new Error('execution reverted')));

    await expect(assertSwapEscrowDeployable(client, swap)).rejects.toThrow(/did not confirm/);
  });

  it('throws when the factory predicts another address', async () => {
    const swap = buildSwapOnWithdraw(await swapArgs());
    const { client } = clientReturning(() => Promise.resolve(EthAddress.random().toString()));

    await expect(assertSwapEscrowDeployable(client, swap)).rejects.toThrow(/predicts/);
  });
});
