import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { TxHash } from '@aztec-labs/stdlib/tx';

import type { buildWithdrawalFinalizationCalldata as buildCalldata } from '@oxide/oxide-client/atlatl/withdrawal_finalization.js';
import { encodeExecutorRelayerPayload } from '@oxide/oxide-lib/executor.js';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import type { PortalDomain } from '@oxide/oxide-lib/types.js';
import {
  type WithdrawalFinalizationData,
  encodeFinalizationData,
} from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PendingL1Operation } from '../state/types.js';
import { initiationFixture, plainWithdrawalFinalizationData } from './initiation_fixture.js';

const buildWithdrawalFinalizationCalldata = jest.fn<typeof buildCalldata>(() => Promise.resolve('0x'));
jest.unstable_mockModule('@oxide/oxide-client/atlatl/withdrawal_finalization.js', () => ({
  buildWithdrawalFinalizationCalldata,
}));
jest.unstable_mockModule('@oxide/oxide-client/archive_ref.js', () => ({
  resolveTxCheckpointArchive: () => Promise.resolve(Fr.random()),
}));
const { WithdrawalCompletion } = await import('./withdrawal_completion.js');

const executor = EthAddress.random();
const operationExecutor = EthAddress.random();
let portalDomain: PortalDomain;

beforeAll(async () => {
  portalDomain = {
    l1Portal: EthAddress.random(),
    l2Token: await AztecAddress.random(),
    teeRegistry: EthAddress.random(),
    rollupVersion: 4n,
    l1ChainId: 1n,
  };
});

beforeEach(() => {
  buildWithdrawalFinalizationCalldata.mockClear();
});

async function completionFor(withdrawals: WithdrawalFinalizationData[], witness: unknown = undefined) {
  const fixture = await initiationFixture(portalDomain, withdrawals);
  const getL2ToL1MembershipWitness = jest.fn((..._args: unknown[]) => Promise.resolve(witness));
  const chain = { ...fixture.node, getL2ToL1MembershipWitness } as any;
  const portal = {
    address: portalDomain.l1Portal,
    getPortalDomain: () => Promise.resolve(portalDomain),
  } as any;
  const completion = new WithdrawalCompletion(chain, portal, portalDomain.l2Token, {} as any, operationExecutor);
  return { completion, fixture, getL2ToL1MembershipWitness };
}

function operation(args: { txHash: string; calldata: Buffer; target?: EthAddress }): PendingL1Operation {
  return {
    operationId: `0x${'ab'.repeat(32)}`,
    broadcaster: AztecAddress.ZERO,
    l2TxHash: args.txHash,
    l2BlockNumber: 1n,
    target: args.target ?? portalDomain.l1Portal,
    payoutToken: EthAddress.random(),
    calldata: args.calldata,
    condition: L1OperationCondition.messageInOutbox(),
    status: 'waiting',
    attempts: 0,
    createdAt: new Date(),
  };
}

describe('WithdrawalCompletion.outboxStatus', () => {
  it('is ready once the requested withdrawal has an Outbox witness, and looks it up by its message position', async () => {
    const withdrawals = [plainWithdrawalFinalizationData(executor), plainWithdrawalFinalizationData(executor)];
    const { completion, fixture, getL2ToL1MembershipWitness } = await completionFor(withdrawals, {});
    const calldata = encodeFinalizationData(withdrawals[1]);

    await expect(completion.outboxStatus(operation({ txHash: fixture.txHash.toString(), calldata }))).resolves.toEqual({
      status: 'ready',
    });
    expect(getL2ToL1MembershipWitness).toHaveBeenCalledWith(fixture.txHash, fixture.effect.l2ToL1Msgs[1], 1);
  });

  it('waits while the message has no witness', async () => {
    const withdrawals = [plainWithdrawalFinalizationData(executor)];
    const { completion, fixture } = await completionFor(withdrawals);
    const calldata = encodeFinalizationData(withdrawals[0]);
    await expect(completion.outboxStatus(operation({ txHash: fixture.txHash.toString(), calldata }))).resolves.toEqual({
      status: 'waiting',
    });
  });

  it('waits when the tx effect cannot be read yet', async () => {
    const withdrawals = [plainWithdrawalFinalizationData(executor)];
    const { completion } = await completionFor(withdrawals, {});
    const calldata = encodeFinalizationData(withdrawals[0]);
    // The fixture node serves only its own tx.
    const unknownTx = TxHash.random().toString();
    await expect(completion.outboxStatus(operation({ txHash: unknownTx, calldata }))).resolves.toEqual({
      status: 'waiting',
    });
  });

  it('is unrecoverable for a malformed request, another portal, or an unattested withdrawal', async () => {
    const withdrawals = [plainWithdrawalFinalizationData(executor)];
    const { completion, fixture } = await completionFor(withdrawals, {});
    const txHash = fixture.txHash.toString();
    const valid = encodeFinalizationData(withdrawals[0]);
    const cases: [PendingL1Operation, string][] = [
      [operation({ txHash, calldata: Buffer.from('not a request') }), 'malformed finalization request'],
      [operation({ txHash, calldata: valid, target: EthAddress.random() }), 'not portal'],
      [
        operation({ txHash, calldata: encodeFinalizationData(plainWithdrawalFinalizationData(executor)) }),
        'did not attest',
      ],
    ];
    for (const [op, reason] of cases) {
      await expect(completion.outboxStatus(op)).resolves.toEqual({
        status: 'unrecoverable',
        reason: expect.stringContaining(reason),
      });
    }
  });

  it('rejects changes to the attested executor or user payload', async () => {
    const withdrawal = {
      ...plainWithdrawalFinalizationData(EthAddress.random()),
      userPayload: Buffer.from('opaque executor input'),
    };
    const { completion, fixture } = await completionFor([withdrawal], {});
    for (const changed of [
      { ...withdrawal, executor: EthAddress.random() },
      { ...withdrawal, userPayload: Buffer.from('different input') },
    ]) {
      const op = operation({ txHash: fixture.txHash.toString(), calldata: encodeFinalizationData(changed) });
      await expect(completion.outboxStatus(op)).resolves.toEqual({
        status: 'unrecoverable',
        reason: expect.stringContaining('did not attest'),
      });
    }
  });
});

describe('WithdrawalCompletion.resolveCalldata', () => {
  it('finalizes through the operation executor and names it as the only tip recipient', async () => {
    const withdrawals = [plainWithdrawalFinalizationData(executor)];
    const { completion, fixture } = await completionFor(withdrawals, {});
    const calldata = encodeFinalizationData(withdrawals[0]);

    await completion.resolveCalldata(operation({ txHash: fixture.txHash.toString(), calldata }));
    expect(buildWithdrawalFinalizationCalldata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        relayerPayload: encodeExecutorRelayerPayload({ tipRecipient: operationExecutor }),
      }),
    );
  });
});

describe('WithdrawalCompletion with an arbitrary executor', () => {
  it('builds finalization calldata for any executor and user payload', async () => {
    const withdrawal = {
      ...plainWithdrawalFinalizationData(EthAddress.random()),
      userPayload: Buffer.from('opaque executor input'),
    };
    const { completion, fixture } = await completionFor([withdrawal], {});
    const op = operation({ txHash: fixture.txHash.toString(), calldata: encodeFinalizationData(withdrawal) });

    await expect(completion.outboxStatus(op)).resolves.toEqual({ status: 'ready' });
    await completion.resolveCalldata(op);
    expect(buildWithdrawalFinalizationCalldata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        withdrawal: { txHash: fixture.txHash, finalizationData: withdrawal },
        relayerPayload: encodeExecutorRelayerPayload({ tipRecipient: operationExecutor }),
      }),
    );
  });
});
