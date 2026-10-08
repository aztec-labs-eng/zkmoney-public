import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { TxHash } from '@aztec/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import type { buildWithdrawalPortalCalldata as buildCalldata } from '@oxide/oxide-client/atlatl/process_withdrawal_request.js';
import type { ChainDataSource } from '@oxide/oxide-client/chain_data_source.js';
import { PermanentError } from '@oxide/oxide-client/errors.js';
import type { PublishedWithdrawal } from '@oxide/oxide-client/published_withdrawal.js';
import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import { computeWithdrawMessageHash } from '@oxide/oxide-lib/hash.js';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { encodePlainRelayerPayload, encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PendingL1Operation } from '../state/types.js';

const publishedWithdrawalModule = await import('@oxide/oxide-client/published_withdrawal.js');
const fetchPublishedWithdrawals = jest.fn<() => Promise<{ withdrawals: PublishedWithdrawal[] }>>();
jest.unstable_mockModule('@oxide/oxide-client/published_withdrawal.js', () => ({
  ...publishedWithdrawalModule,
  fetchPublishedWithdrawals,
}));
const buildWithdrawalPortalCalldata = jest.fn<typeof buildCalldata>(() => Promise.resolve('0x'));
jest.unstable_mockModule('@oxide/oxide-client/atlatl/process_withdrawal_request.js', () => ({
  buildWithdrawalPortalCalldata,
}));
jest.unstable_mockModule('@oxide/oxide-client/archive_ref.js', () => ({
  resolveBurnCheckpointArchive: () => Promise.resolve(Fr.random()),
}));
const { WithdrawalCompletion } = await import('./withdrawal_completion.js');

const PORTAL = EthAddress.random();
const CHAIN_ID = 31337n;
const ROLLUP_VERSION = 1n;
const L2_TOKEN = AztecAddress.fromBigIntUnsafe(1n);
const PLAIN_EXECUTOR = EthAddress.random();
const OPERATION_EXECUTOR = EthAddress.random();
const WITHDRAWAL_SUBSIDY = EthAddress.random();
const RECIPIENT = EthAddress.random();
const RELAYER_TIP = 5n;
const TX_HASH = TxHash.random().toString();

/** A withdrawal the burn tx publishes through the plain executor, with a payload that matches its hash. */
function publishedWithdrawal(overrides: Partial<PublishedWithdrawal> = {}): PublishedWithdrawal {
  return {
    executor: PLAIN_EXECUTOR,
    userPayloadHash: getUserPayloadHash(
      encodePlainWithdrawalPayload({ recipient: RECIPIENT, relayerTip: RELAYER_TIP }),
    ),
    amount: 100n,
    proverTip: 1n,
    randomness: Fr.random(),
    recipient: RECIPIENT,
    relayerTip: RELAYER_TIP,
    signature: { sLo: Fr.ZERO, sHi: Fr.ZERO, rLo: Fr.ZERO, rHi: Fr.ZERO },
    ...overrides,
  };
}

function buildCompletion(witness?: object) {
  const getL2ToL1MembershipWitness = jest.fn((_txHash: TxHash, _messageHash: Fr) => Promise.resolve(witness));
  const chain = { getL2ToL1MembershipWitness } as unknown as ChainDataSource;
  const portal = {
    address: PORTAL,
    getRollupVersion: () => Promise.resolve(ROLLUP_VERSION),
    getChainId: () => CHAIN_ID,
  } as unknown as OxidePortalContract;
  const completion = new WithdrawalCompletion(
    chain,
    portal,
    L2_TOKEN,
    {} as TeeSigner,
    PLAIN_EXECUTOR,
    OPERATION_EXECUTOR,
    WITHDRAWAL_SUBSIDY,
  );
  return { completion, getL2ToL1MembershipWitness };
}

const OPERATION: PendingL1Operation = {
  operationId: `0x${'ab'.repeat(32)}`,
  broadcaster: AztecAddress.fromBigIntUnsafe(7n),
  l2TxHash: TX_HASH,
  l2BlockNumber: 5n,
  target: EthAddress.random(),
  payoutToken: EthAddress.random(),
  calldata: Buffer.alloc(0),
  condition: L1OperationCondition.messageInOutbox(),
  status: 'pending',
  attempts: 0,
  createdAt: new Date(),
};

describe('WithdrawalCompletion', () => {
  beforeEach(() => {
    fetchPublishedWithdrawals.mockReset();
    buildWithdrawalPortalCalldata.mockClear();
  });

  it('marks a burn tx that published no withdrawal unrecoverable', async () => {
    fetchPublishedWithdrawals.mockResolvedValue({ withdrawals: [] });
    const { completion, getL2ToL1MembershipWitness } = buildCompletion({});

    await expect(completion.outboxStatus(TX_HASH)).resolves.toBe('unrecoverable');
    expect(getL2ToL1MembershipWitness).not.toHaveBeenCalled();
  });

  it('marks a withdrawal through an executor it does not know unrecoverable', async () => {
    fetchPublishedWithdrawals.mockResolvedValue({
      withdrawals: [publishedWithdrawal({ executor: EthAddress.random() })],
    });
    const { completion } = buildCompletion({});

    await expect(completion.outboxStatus(TX_HASH)).resolves.toBe('unrecoverable');
    await expect(completion.resolveCalldata(OPERATION)).rejects.toThrow(PermanentError);
  });

  it('waits while the message has no Outbox witness, and is ready once it has one', async () => {
    const withdrawal = publishedWithdrawal();
    fetchPublishedWithdrawals.mockResolvedValue({ withdrawals: [withdrawal] });

    await expect(buildCompletion(undefined).completion.outboxStatus(TX_HASH)).resolves.toBe('waiting');
    const { completion, getL2ToL1MembershipWitness } = buildCompletion({});
    await expect(completion.outboxStatus(TX_HASH)).resolves.toBe('ready');
    // The lookup asks for the message the burn tx emitted, so a witness for another message never makes it ready.
    expect(getL2ToL1MembershipWitness).toHaveBeenCalledWith(
      TxHash.fromString(TX_HASH),
      computeWithdrawMessageHash(
        { l1Portal: PORTAL, l1ChainId: CHAIN_ID, l2Portal: L2_TOKEN, rollupVersion: ROLLUP_VERSION },
        withdrawal,
      ),
    );
  });

  it('waits when the tx effect cannot be read yet', async () => {
    fetchPublishedWithdrawals.mockRejectedValue(new Error(`Tx effect not found for hash ${TX_HASH}`));
    const { completion } = buildCompletion({});

    await expect(completion.outboxStatus(TX_HASH)).resolves.toBe('waiting');
  });

  it('settles through the operation executor and claims the configured withdrawal subsidy', async () => {
    fetchPublishedWithdrawals.mockResolvedValue({ withdrawals: [publishedWithdrawal()] });
    const { completion } = buildCompletion({});

    await completion.resolveCalldata(OPERATION);
    expect(buildWithdrawalPortalCalldata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        relayerPayload: encodePlainRelayerPayload({
          tipRecipient: OPERATION_EXECUTOR,
          withdrawalSubsidy: WITHDRAWAL_SUBSIDY,
        }),
      }),
    );
  });
});
