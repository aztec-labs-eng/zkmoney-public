import { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import {
  ARCHIVE_HEIGHT,
  L1_TO_L2_MSG_TREE_HEIGHT,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_PRIVATE_LOGS_PER_TX,
  PRIVATE_LOG_SIZE_IN_FIELDS,
} from '@aztec-labs/constants';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { BlockHeader, TxEffect } from '@aztec-labs/stdlib/tx';

import { describe, expect, it } from '@jest/globals';

import { sealEncryptedRequest } from './codec.js';
import { generateEncryptionKeypair } from './encryption.js';
import { MAX_MESSAGE_SIZE, frame } from './framing.js';
import { toTxEffectHintData } from './tx_effect_hint.js';
import {
  MAX_TX_EFFECTS_TREE_DEPTH,
  type NoteData,
  type SpendValidationData,
  type TokenOperation,
  TokenOperationSchema,
  type TxEffectHintData,
} from './types.js';

// we expect msg.len() * MAX_HEADROOM < MAX_MESSAGE_SIZE
const MAX_HEADROOM = 1.2;

const U128_MAX = 2n ** 128n - 1n;

type SpentDepositPath = TokenOperation['deposits'][number]['siblingPath'];

const hintFieldCount = (hint: TxEffectHintData) =>
  6 + hint.noteHashes.length + hint.nullifiers.length + hint.l2ToL1Msgs.length + hint.privateLogs.flat().length;

async function maximalTxEffectHint(): Promise<TxEffectHintData> {
  const effect = await TxEffect.random({
    numNoteHashes: MAX_NOTE_HASHES_PER_TX,
    numNullifiers: MAX_NULLIFIERS_PER_TX,
    numL2ToL1Msgs: MAX_L2_TO_L1_MSGS_PER_TX,
    numPrivateLogs: MAX_PRIVATE_LOGS_PER_TX,
  });
  return toTxEffectHintData(effect);
}

async function maximalNote(): Promise<NoteData> {
  return { amount: U128_MAX, owner: await AztecAddress.random(), randomness: Fr.random() };
}

async function maximalSpend(txEffect: TxEffectHintData): Promise<SpendValidationData> {
  return {
    note: await maximalNote(),
    ownerAddressPreimage: await CompleteAddress.random(),
    masterNullifierHidingKey: GrumpkinScalar.random(),
    hints: {
      anchorRelation: {
        kind: 'txBlockIsAncestorOfAnchor',
        archiveMembershipWitness: MembershipWitness.random(ARCHIVE_HEIGHT),
      },
      txEffectsHints: {
        txBlockHeader: BlockHeader.random(),
        txEffect,
        leafIndex: 2n ** BigInt(MAX_TX_EFFECTS_TREE_DEPTH) - 1n,
        siblingPath: Array.from({ length: MAX_TX_EFFECTS_TREE_DEPTH }, () => Fr.random()),
      },
    },
    signature: { sLo: Fr.random(), sHi: Fr.random(), rLo: Fr.random(), rHi: Fr.random() },
    anchorBlockHashMembershipWitness: MembershipWitness.random(ARCHIVE_HEIGHT),
    signerRegistrationWitness: MembershipWitness.random(L1_TO_L2_MSG_TREE_HEIGHT),
  };
}

/** Every array of the operation at the cap that `TokenOperationSchema` enforces, every value at its widest. */
async function maximalTokenOperation(): Promise<TokenOperation> {
  const txEffect = await maximalTxEffectHint();
  const times = <T>(n: number, make: () => Promise<T>) => Promise.all(Array.from({ length: n }, make));
  return {
    anchorBlockHeader: BlockHeader.random(),
    spentNotes: await times(MAX_NULLIFIERS_PER_TX, () => maximalSpend(txEffect)),
    createdNotes: await times(MAX_NOTE_HASHES_PER_TX, maximalNote),
    deposits: await times(MAX_NULLIFIERS_PER_TX, async () => ({
      recipient: await AztecAddress.random(),
      recipientAddressPreimage: await CompleteAddress.random(),
      masterNullifierHidingKey: GrumpkinScalar.random(),
      amount: U128_MAX,
      sharedSecretSalt: Fr.random(),
      messageLeafIndex: 2n ** BigInt(L1_TO_L2_MSG_TREE_HEIGHT) - 1n,
      siblingPath: Array.from({ length: L1_TO_L2_MSG_TREE_HEIGHT }, () => Fr.random()) as SpentDepositPath,
    })),
    withdrawals: Array.from({ length: MAX_L2_TO_L1_MSGS_PER_TX }, () => ({
      executor: EthAddress.random(),
      userPayloadHash: Fr.random(),
      amount: U128_MAX,
      proverTip: U128_MAX,
      randomness: Fr.random(),
    })),
  };
}

describe('MAX_MESSAGE_SIZE', () => {
  it('admits the largest legal sealed signTokenOperation with a small margin', async () => {
    const op = await maximalTokenOperation();

    const hint = op.spentNotes[0].hints.txEffectsHints.txEffect;
    expect(hint.privateLogs.every(log => log.length === PRIVATE_LOG_SIZE_IN_FIELDS)).toBe(true);
    expect(hintFieldCount(hint)).toBe(1166);
    // The enclave accepts the operation, so the size below is reachable by a legal request.
    await expect(TokenOperationSchema.parseAsync(JSON.parse(jsonStringify(op)))).resolves.toBeDefined();

    const enclave = await generateEncryptionKeypair();
    const domain = {
      l1Portal: EthAddress.random(),
      l2Token: await AztecAddress.random(),
      teeRegistry: EthAddress.random(),
      l1ChainId: 2n ** 64n - 1n,
      rollupVersion: 2n ** 64n - 1n,
    };
    const { body } = await sealEncryptedRequest(enclave.publicKey, 'signTokenOperation', op, domain, {
      discloseDomain: true,
    });
    const size = Buffer.byteLength(body, 'utf8');

    expect(() => frame(body)).not.toThrow();
    expect(size).toBeLessThanOrEqual(MAX_MESSAGE_SIZE);
    expect(MAX_MESSAGE_SIZE).toBeLessThanOrEqual(size * MAX_HEADROOM);
  });
});
