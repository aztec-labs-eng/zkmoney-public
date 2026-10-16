import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec/aztec.js/fields';
import { BlockNumber, CheckpointNumber } from '@aztec/foundation/branded-types';
import { deriveKeys } from '@aztec/stdlib/keys';
import { AppendOnlyTreeSnapshot } from '@aztec/stdlib/trees';
import { BlockHeader, PartialStateReference, StateReference } from '@aztec/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { computeAccountAddress } from '@oxide/oxide-lib/account_address.js';
import { computeDepositMessageHash } from '@oxide/oxide-lib/deposit_message_hashing.js';
import type { RefundOwner } from '@oxide/oxide-lib/refund_authorization.js';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';
import { buildFrozenDepositRefundProof } from './frozen_deposit.js';
import { buildUnprocessedDepositRefundProof } from './unprocessed_deposit.js';

const NEXT_AVAILABLE_LEAF_INDEX = 2048n;
const ABSORBED_LEAF_INDEX = 1029n;
const UNPROCESSED_LEAF_INDEX = NEXT_AVAILABLE_LEAF_INDEX + 5n;

/** An account whose address commits to no passkey, so it authorizes a refund with its master fallback key. */
async function fallbackKeyOwner(): Promise<{ owner: RefundOwner; masterNullifierHidingKey: GrumpkinScalar }> {
  const { masterNullifierHidingSecretKey, masterFallbackSecretKey, publicKeys } = await deriveKeys(Fr.random());
  const instance = {
    contractClassId: Fr.random(),
    salt: Fr.random(),
    initializationHash: Fr.random(),
    deployer: AztecAddress.ZERO,
  };
  return {
    owner: {
      address: await computeAccountAddress(publicKeys, instance, Fr.ZERO),
      publicKeys,
      instance,
      authorizer: { kind: 'fallbackKey', masterFallbackSecretKey },
    },
    masterNullifierHidingKey: masterNullifierHidingSecretKey,
  };
}

describe('deposit refund proof builders', () => {
  let l2Portal: AztecAddress;
  let portal: OxidePortalContract;
  let frozenTip: BlockHeader;
  let archive: ArchiveRef;
  let owner: RefundOwner;
  let masterNullifierHidingKey: GrumpkinScalar;
  let getL1ToL2MessageMembershipWitness: jest.Mock<ChainDataSource['getL1ToL2MessageMembershipWitness']>;
  let getBlockHashMembershipWitness: jest.Mock<ChainDataSource['getBlockHashMembershipWitness']>;
  let chain: ChainDataSource;
  let signFrozenDepositRefundFinalization: jest.Mock<TeeSigner['signFrozenDepositRefundFinalization']>;
  let signUnprocessedDepositRefundFinalization: jest.Mock<TeeSigner['signUnprocessedDepositRefundFinalization']>;
  let signer: TeeSigner;

  async function depositAt(messageLeafIndex: bigint) {
    const deposit = { sharedSecretSalt: Fr.random(), amount: 1_000n, messageLeafIndex };
    const messageKey = await computeDepositMessageHash(
      { l1Portal: portal.address, l1ChainId: portal.getChainId(), l2Portal, rollupVersion: 7n },
      { ...deposit, recipient: owner.address, messageLeafIndex: new Fr(messageLeafIndex) },
    );
    return { ...deposit, messageKey };
  }

  beforeEach(async () => {
    l2Portal = await AztecAddress.random();
    portal = {
      address: EthAddress.random(),
      getChainId: () => 31337n,
      getL2Portal: () => Promise.resolve(l2Portal),
      getRollupVersion: () => Promise.resolve(7n),
    } as unknown as OxidePortalContract;
    frozenTip = BlockHeader.empty({
      state: new StateReference(
        new AppendOnlyTreeSnapshot(Fr.random(), Number(NEXT_AVAILABLE_LEAF_INDEX)),
        PartialStateReference.empty(),
      ),
    });
    archive = {
      root: Fr.random(),
      checkpointNumber: CheckpointNumber(2),
      checkpointEndBlockHeader: frozenTip,
      witnessReferenceBlockNumber: BlockNumber(5),
    };
    ({ owner, masterNullifierHidingKey } = await fallbackKeyOwner());
    getL1ToL2MessageMembershipWitness = jest
      .fn<ChainDataSource['getL1ToL2MessageMembershipWitness']>()
      .mockResolvedValue(undefined);
    getBlockHashMembershipWitness = jest.fn<ChainDataSource['getBlockHashMembershipWitness']>();
    chain = { getL1ToL2MessageMembershipWitness, getBlockHashMembershipWitness } as unknown as ChainDataSource;
    signFrozenDepositRefundFinalization = jest.fn<TeeSigner['signFrozenDepositRefundFinalization']>();
    signUnprocessedDepositRefundFinalization = jest.fn<TeeSigner['signUnprocessedDepositRefundFinalization']>();
    signer = { signFrozenDepositRefundFinalization, signUnprocessedDepositRefundFinalization } as unknown as TeeSigner;
  });

  describe('buildFrozenDepositRefundProof', () => {
    it('refuses a deposit that the frozen tip did not absorb', async () => {
      const deposit = await depositAt(UNPROCESSED_LEAF_INDEX);

      await expect(
        buildFrozenDepositRefundProof(portal, {
          chain,
          signer,
          l2Token: await AztecAddress.random(),
          archive,
          executor: EthAddress.random(),
          userPayloadHash: Fr.random(),
          l2Recipient: owner,
          l2RecipientMasterNullifierHidingKey: masterNullifierHidingKey,
          ...deposit,
        }),
      ).rejects.toStrictEqual(
        new PermanentError(
          `The frozen tip did not absorb the deposit message at leaf index ${UNPROCESSED_LEAF_INDEX}, so it is not a frozen deposit`,
        ),
      );
      expect(getL1ToL2MessageMembershipWitness).not.toHaveBeenCalled();
      expect(signFrozenDepositRefundFinalization).not.toHaveBeenCalled();
    });
  });

  describe('buildUnprocessedDepositRefundProof', () => {
    it('refuses a deposit that the frozen tip absorbed', async () => {
      const deposit = await depositAt(ABSORBED_LEAF_INDEX);

      await expect(
        buildUnprocessedDepositRefundProof(portal, {
          chain,
          signer,
          l2Token: await AztecAddress.random(),
          frozenArchive: archive,
          executor: EthAddress.random(),
          amount: deposit.amount,
          userPayloadHash: Fr.random(),
          sharedSecretSalt: deposit.sharedSecretSalt,
          l2Recipient: owner,
          l2RecipientMasterNullifierHidingKey: masterNullifierHidingKey,
          messageLeafIndex: deposit.messageLeafIndex,
        }),
      ).rejects.toStrictEqual(
        new PermanentError(
          `The frozen tip absorbed the deposit message at leaf index ${ABSORBED_LEAF_INDEX}, so it is not an unprocessed deposit`,
        ),
      );
      expect(getBlockHashMembershipWitness).not.toHaveBeenCalled();
      expect(signUnprocessedDepositRefundFinalization).not.toHaveBeenCalled();
    });
  });
});
