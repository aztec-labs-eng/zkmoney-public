import { PRIVATE_LOG_SIZE_IN_FIELDS } from '@aztec-labs/constants';
import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHash } from '@aztec-labs/stdlib/block';
import { PrivateLog } from '@aztec-labs/stdlib/logs';
import { type Tx, TxEffect, TxHash } from '@aztec-labs/stdlib/tx';

import { computeSiloedWithdrawalMessageHashesTag } from '@oxide/oxide-lib/da_extractors.js';
import { computeWithdrawMessageHash } from '@oxide/oxide-lib/hash.js';
import {
  L1OperationCondition,
  encodeL1OperationCalldata,
  l1OperationEventSelector,
} from '@oxide/oxide-lib/l1_operation_calldata.js';
import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal_executor.js';
import { type PortalDomain, ZERO_K1_NOTE_SIGNATURE } from '@oxide/oxide-lib/types.js';
import {
  type WithdrawalFinalizationData,
  encodeFinalizationData,
  toOutboxWithdrawal,
} from '@oxide/oxide-lib/withdrawal_finalization_data.js';

/** The finalization data of a plain withdrawal, for tests. */
export function plainWithdrawalFinalizationData(executor: EthAddress): WithdrawalFinalizationData {
  return {
    executor,
    amount: 1000n,
    proverTip: 10n,
    randomness: Fr.random(),
    withdrawalSignature: ZERO_K1_NOTE_SIGNATURE,
    userPayload: encodePlainWithdrawalPayload({ recipient: EthAddress.random(), relayerTip: 100n }),
  };
}

/**
 * An initiation tx that attests and sends `withdrawals`, and broadcasts a finalization request for each one in
 * `withdrawalsToBroadcast` (all by default) through a random Broadcaster. Returns the Broadcaster and node methods that
 * serve the tx.
 */
export async function initiationFixture(
  portal: PortalDomain,
  withdrawals: WithdrawalFinalizationData[],
  withdrawalsToBroadcast = withdrawals,
) {
  const txHash = TxHash.random();
  const broadcaster = await AztecAddress.random();
  const hashes = withdrawals.map(withdrawal => computeWithdrawMessageHash(portal, toOutboxWithdrawal(withdrawal)));
  const fields = Array.from({ length: PRIVATE_LOG_SIZE_IN_FIELDS }, () => Fr.ZERO);
  fields[0] = await computeSiloedWithdrawalMessageHashesTag(portal.l2Token);
  hashes.forEach((hash, i) => (fields[i + 1] = hash));
  const effect = TxEffect.empty();
  effect.txHash = txHash;
  effect.privateLogs = [new PrivateLog(fields as PrivateLog['fields'], hashes.length + 1)];
  effect.l2ToL1Msgs = hashes;

  const selector = (await l1OperationEventSelector()).toField();
  const condition = L1OperationCondition.messageInOutbox();
  const calls = withdrawalsToBroadcast.map(finalizationData => {
    const { bytesLen, fields: calldata } = encodeL1OperationCalldata(encodeFinalizationData(finalizationData));
    return {
      request: { contractAddress: broadcaster },
      calldata: [
        selector,
        portal.l1Portal.toField(),
        EthAddress.random().toField(),
        new Fr(bytesLen),
        new Fr(condition.kind),
        condition.token.toField(),
        condition.recipient.toField(),
        ...calldata,
      ],
    };
  });
  const tx = { getPublicCallRequestsWithCalldata: () => calls } as unknown as Tx;
  return {
    txHash,
    broadcaster,
    effect,
    node: {
      getTxByHash: (hash: TxHash) => Promise.resolve(hash.equals(txHash) ? tx : undefined),
      getTxEffect: (hash: TxHash) =>
        Promise.resolve(
          hash.equals(txHash)
            ? {
                data: effect,
                l2BlockNumber: BlockNumber(1),
                l2BlockHash: BlockHash.ZERO,
                txIndexInBlock: 0,
                slotNumber: SlotNumber(1),
              }
            : undefined,
        ),
    },
  };
}
