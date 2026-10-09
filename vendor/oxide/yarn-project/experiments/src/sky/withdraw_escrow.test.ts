import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';

import { fakeBroadcaster } from '@oxide/oxide-client/withdraw_escrows/test_helpers.js';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { decodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import { describe, expect, it } from '@jest/globals';

import { SkyRoute, encodeSkyEscrowDeploy, predictSkyEscrowAddressLocally } from './sky_savings.js';
import { type SkyEscrowWithdrawalArgs, buildSkyEscrowWithdrawal } from './withdraw_escrow.js';

async function skyArgs(): Promise<SkyEscrowWithdrawalArgs> {
  return {
    broadcaster: fakeBroadcaster(),
    skyEscrowFactory: EthAddress.random(),
    dai: EthAddress.random(),
    from: await AztecAddress.random(),
    withdrawalExecutor: EthAddress.random(),
    amount: 1_000n,
    withdrawalRelayerTip: 10n,
    proverTip: 0n,
    fpcFundingCut: 0n,
    route: SkyRoute.Stake,
    recipientCommitment: Fr.random().toString(),
    recoveryAccount: EthAddress.random(),
    relayerTip: 20n,
  };
}

describe('buildSkyEscrowWithdrawal', () => {
  it('commits the escrow to the route, the deposit it makes and the recovery salt', async () => {
    const args = await skyArgs();
    const nonce = Fr.random().toString();
    const recoverySalt = Fr.random();

    const sky = buildSkyEscrowWithdrawal({ ...args, nonce, recoverySalt });

    expect(sky.escrowArgs).toEqual({
      route: SkyRoute.Stake,
      recipientCommitment: args.recipientCommitment,
      recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString(),
      relayerTip: args.relayerTip,
      nonce,
    });
    expect(sky.escrow).toEqual(
      EthAddress.fromString(predictSkyEscrowAddressLocally(args.skyEscrowFactory.toString(), sky.escrowArgs)),
    );
  });

  it('withdraws to the escrow and broadcasts the run the escrow waits for', async () => {
    const args = await skyArgs();

    const { escrow, escrowArgs, operation, l1Operation } = buildSkyEscrowWithdrawal(args);

    if (operation.kind !== 'withdraw') {
      throw new Error('expected a withdraw operation');
    }
    expect(operation.executor.equals(args.withdrawalExecutor)).toBe(true);
    const payload = decodePlainWithdrawalPayload(operation.userPayload);
    expect(payload.recipient.equals(escrow)).toBe(true);
    expect(payload.relayerTip).toBe(args.withdrawalRelayerTip);
    expect(l1Operation.target.equals(args.skyEscrowFactory)).toBe(true);
    expect(l1Operation.calldata).toEqual(Buffer.from(encodeSkyEscrowDeploy(escrowArgs).slice(2), 'hex'));
    expect(l1Operation.condition).toEqual(L1OperationCondition.balance(args.dai, escrow));
  });
});
