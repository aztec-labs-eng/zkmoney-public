import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, type GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { CheckpointNumber, TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { deriveKeys } from '@aztec-labs/stdlib/keys';
import { AppendOnlyTreeSnapshot } from '@aztec-labs/stdlib/trees';
import { BlockHeader, PartialStateReference, StateReference } from '@aztec-labs/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { computeAccountAddress } from '@oxide/oxide-lib/account_address.js';
import { computeDepositMessageHash } from '@oxide/oxide-lib/deposit_message_hashing.js';
import type { RefundOwner } from '@oxide/oxide-lib/migration_signature.js';
import type { PortalDomain, TeeSigner } from '@oxide/oxide-lib/types.js';
import { MAX_FROZEN_DEPOSITS_PER_REFUND } from '@oxide/refund-proof/frozen_deposits_refund/types.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ArchiveRef } from './archive_ref.js';
import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';
import { buildFrozenDepositsRefundProof } from './frozen_deposits.js';
import { signMigration } from './sign_migration.js';
import { buildUnprocessedDepositRefundProof } from './unprocessed_deposit.js';

const NEXT_AVAILABLE_LEAF_INDEX = 2048n;
const ABSORBED_LEAF_INDEX = 1029n;
const UNPROCESSED_LEAF_INDEX = NEXT_AVAILABLE_LEAF_INDEX + 5n;

/** An account whose address commits to no passkey, so it signs migrations with its master fallback key. */
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
      signer: { kind: 'fallbackKey', fbskM: masterFallbackSecretKey },
    },
    masterNullifierHidingKey: masterNullifierHidingSecretKey,
  };
}

describe('deposit refund proof builders', () => {
  let portalDomain: PortalDomain;
  let portal: OxidePortalContract;
  let frozenTip: BlockHeader;
  let archive: ArchiveRef;
  let owner: RefundOwner;
  let masterNullifierHidingKey: GrumpkinScalar;
  let getL1ToL2MessageMembershipWitness: jest.Mock<ChainDataSource['getL1ToL2MessageMembershipWitness']>;
  let getBlockHashMembershipWitnessAtArchive: jest.Mock<ChainDataSource['getBlockHashMembershipWitnessAtArchive']>;
  let chain: ChainDataSource;
  let signFrozenDepositsRefundFinalization: jest.Mock<TeeSigner['signFrozenDepositsRefundFinalization']>;
  let signUnprocessedDepositRefundFinalization: jest.Mock<TeeSigner['signUnprocessedDepositRefundFinalization']>;
  let signer: TeeSigner;

  async function depositAt(messageLeafIndex: bigint) {
    const deposit = { sharedSecretSalt: Fr.random(), amount: 1_000n, messageLeafIndex };
    const messageKey = await computeDepositMessageHash(portalDomain, {
      ...deposit,
      recipient: owner.address,
      messageLeafIndex: new Fr(messageLeafIndex),
    });
    return { ...deposit, messageKey };
  }

  beforeEach(async () => {
    portalDomain = {
      l1Portal: EthAddress.random(),
      l1ChainId: 31337n,
      l2Token: await AztecAddress.random(),
      teeRegistry: EthAddress.random(),
      rollupVersion: 7n,
    };
    portal = { getPortalDomain: () => Promise.resolve(portalDomain) } as unknown as OxidePortalContract;
    frozenTip = BlockHeader.empty({
      state: new StateReference(
        new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(Number(NEXT_AVAILABLE_LEAF_INDEX))),
        PartialStateReference.empty(),
      ),
    });
    archive = {
      root: Fr.random(),
      checkpointNumber: CheckpointNumber(2),
      checkpointEndBlockHeader: frozenTip,
    };
    ({ owner, masterNullifierHidingKey } = await fallbackKeyOwner());
    getL1ToL2MessageMembershipWitness = jest
      .fn<ChainDataSource['getL1ToL2MessageMembershipWitness']>()
      .mockResolvedValue(undefined);
    getBlockHashMembershipWitnessAtArchive = jest.fn<ChainDataSource['getBlockHashMembershipWitnessAtArchive']>();
    chain = { getL1ToL2MessageMembershipWitness, getBlockHashMembershipWitnessAtArchive } as unknown as ChainDataSource;
    signFrozenDepositsRefundFinalization = jest.fn<TeeSigner['signFrozenDepositsRefundFinalization']>();
    signUnprocessedDepositRefundFinalization = jest.fn<TeeSigner['signUnprocessedDepositRefundFinalization']>();
    signer = { signFrozenDepositsRefundFinalization, signUnprocessedDepositRefundFinalization } as unknown as TeeSigner;
  });

  describe('buildFrozenDepositsRefundProof', () => {
    it('refuses a deposit that the frozen tip did not absorb', async () => {
      const deposit = await depositAt(UNPROCESSED_LEAF_INDEX);
      const executor = EthAddress.random();
      const userPayloadHash = Fr.random();

      await expect(
        buildFrozenDepositsRefundProof(portal, {
          chain,
          signer,
          archive,
          executor,
          userPayloadHash,
          l2Recipient: owner,
          l2RecipientMasterNullifierHidingKey: masterNullifierHidingKey,
          deposits: [deposit],
          migrationSignature: await signMigration({ signer: owner.signer, executor, userPayloadHash }),
        }),
      ).rejects.toStrictEqual(
        new PermanentError(
          `The frozen tip did not absorb the deposit message at leaf index ${UNPROCESSED_LEAF_INDEX}, so it is not a frozen deposit`,
        ),
      );
      expect(getL1ToL2MessageMembershipWitness).not.toHaveBeenCalled();
      expect(signFrozenDepositsRefundFinalization).not.toHaveBeenCalled();
    });

    it.each([
      ['no deposits', 0, 'A frozen deposit refund needs at least one deposit'],
      [
        'more deposits than the circuit holds',
        MAX_FROZEN_DEPOSITS_PER_REFUND + 1,
        `Cannot refund more than ${MAX_FROZEN_DEPOSITS_PER_REFUND} deposits in a single proof, got ${MAX_FROZEN_DEPOSITS_PER_REFUND + 1}`,
      ],
    ])('refuses %s', async (_, count, message) => {
      const executor = EthAddress.random();
      const userPayloadHash = Fr.random();
      const deposits = await Promise.all(Array.from({ length: count }, () => depositAt(ABSORBED_LEAF_INDEX)));

      await expect(
        buildFrozenDepositsRefundProof(portal, {
          chain,
          signer,
          archive,
          executor,
          userPayloadHash,
          l2Recipient: owner,
          l2RecipientMasterNullifierHidingKey: masterNullifierHidingKey,
          deposits,
          migrationSignature: await signMigration({ signer: owner.signer, executor, userPayloadHash }),
        }),
      ).rejects.toStrictEqual(new PermanentError(message));
      expect(getL1ToL2MessageMembershipWitness).not.toHaveBeenCalled();
      expect(signFrozenDepositsRefundFinalization).not.toHaveBeenCalled();
    });
  });

  describe('buildUnprocessedDepositRefundProof', () => {
    it('refuses a deposit that the frozen tip absorbed', async () => {
      const deposit = await depositAt(ABSORBED_LEAF_INDEX);
      const executor = EthAddress.random();
      const userPayloadHash = Fr.random();

      await expect(
        buildUnprocessedDepositRefundProof(portal, {
          chain,
          signer,
          frozenArchive: archive,
          executor,
          amount: deposit.amount,
          userPayloadHash,
          sharedSecretSalt: deposit.sharedSecretSalt,
          l2Recipient: owner,
          l2RecipientMasterNullifierHidingKey: masterNullifierHidingKey,
          messageLeafIndex: deposit.messageLeafIndex,
          migrationSignature: await signMigration({ signer: owner.signer, executor, userPayloadHash }),
        }),
      ).rejects.toStrictEqual(
        new PermanentError(
          `The frozen tip absorbed the deposit message at leaf index ${ABSORBED_LEAF_INDEX}, so it is not an unprocessed deposit`,
        ),
      );
      expect(getBlockHashMembershipWitnessAtArchive).not.toHaveBeenCalled();
      expect(signUnprocessedDepositRefundFinalization).not.toHaveBeenCalled();
    });
  });
});
