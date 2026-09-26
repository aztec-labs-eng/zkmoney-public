import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';

import { SwapRoute, encodeSwapEscrowDeploy, predictSwapEscrowAddressLocally } from '@oxide/l1-contracts';
import { L1OperationCondition, L1_OPERATION_BROADCAST_TIERS } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { decodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import { describe, expect, it, jest } from '@jest/globals';

import type { L1OperationBroadcaster } from './broadcaster_calls.js';
import { type SwapOnWithdrawArgs, buildSwapOnWithdraw } from './swap_on_withdraw.js';

type TierMethodName = keyof L1OperationBroadcaster['methods'];
type TierMethod = L1OperationBroadcaster['methods'][TierMethodName];

function fakeBroadcaster(): L1OperationBroadcaster {
  const methods = Object.fromEntries(
    L1_OPERATION_BROADCAST_TIERS.map(tier => [
      tier.method,
      jest.fn<TierMethod>(() => ({}) as ContractFunctionInteraction),
    ]),
  ) as Record<TierMethodName, jest.Mock<TierMethod>>;
  return { methods };
}

async function swapArgs(): Promise<SwapOnWithdrawArgs> {
  return {
    broadcaster: fakeBroadcaster(),
    swapEscrowFactory: EthAddress.random(),
    dai: EthAddress.random(),
    from: await AztecAddress.random(),
    plainWithdrawalExecutor: EthAddress.random(),
    amount: 1_000n,
    withdrawalRelayerTip: 10n,
    proverTip: 5n,
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
      recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString(),
      relayerTip: args.relayerTip,
      nonce,
    });
    expect(swap.escrow).toEqual(
      EthAddress.fromString(predictSwapEscrowAddressLocally(args.swapEscrowFactory.toString(), swap.escrowArgs)),
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

    expect(l1Operation.target.equals(args.swapEscrowFactory)).toBe(true);
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
});
