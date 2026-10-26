import { ARCHIVE_HEIGHT, DomainSeparator } from '@aztec-labs/constants';
import { makeTuple } from '@aztec-labs/foundation/array';
import { BlockNumber, SlotNumber, TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import { RevertCode } from '@aztec-labs/stdlib/avm';
import { AppendOnlyTreeSnapshot } from '@aztec-labs/stdlib/trees';
import { BlockHeader, GlobalVariables, TxEffect, computeTxEffectMembershipWitness } from '@aztec-labs/stdlib/tx';

import type { TeeTxEffect } from '@oxide/oxide-lib-tee/tx_effect_hint.js';
import { type TxEffectHintData, type TxEffectsHints, TxEffectsHintsSchema } from '@oxide/oxide-lib-tee/types.js';
import { testConstrained } from '@oxide/oxide-lib/constrained.js';
import { toTxEffectHintData } from '@oxide/oxide-lib/tx_effect_hint.js';

import { describe, expect, it } from '@jest/globals';

import {
  verifyAndDecodeArchivedTxEffects,
  verifyAndDecodeTxEffectsAtAnchor,
  verifyTxEffectInBlock,
} from './verify_and_decode_tx_effects.js';

/** Makes a real archive proof with one selected leaf and fixed siblings. */
async function archiveProof(header: BlockHeader) {
  const siblingPath = makeTuple(ARCHIVE_HEIGHT, () => Fr.ZERO);
  const leafIndex = BigInt(header.getBlockNumber());
  let index = leafIndex;
  let root = new Fr((await header.hash()).toBuffer());
  for (const sibling of siblingPath) {
    const pair = (index & 1n) === 0n ? [root, sibling] : [sibling, root];
    root = await poseidon2HashWithSeparator(pair, DomainSeparator.MERKLE_HASH);
    index >>= 1n;
  }
  return { root, witness: new MembershipWitness(ARCHIVE_HEIGHT, leafIndex, siblingPath) };
}

const FULL_TX_SHAPE = {
  numNoteHashes: 2,
  numNullifiers: 2,
  numL2ToL1Msgs: 1,
  numPublicDataWrites: 1,
  numPrivateLogs: 2,
  numPublicCallsPerTx: 1,
  numPublicLogsPerCall: 1,
  numContractClassLogs: 1,
};

/** Makes a block of txs and the hints for the tx at `txIndex`. */
async function makeBlockOf(txs: TxEffect[], txIndex: number) {
  const witness = await computeTxEffectMembershipWitness(txs, txIndex);
  const txBlockHeader = BlockHeader.empty({
    txEffectsTreeRoot: witness.root,
    globalVariables: GlobalVariables.empty({ blockNumber: BlockNumber(3), slotNumber: SlotNumber(2) }),
  });
  const hints: TxEffectsHints = {
    txBlockHeader,
    txEffect: await toTxEffectHintData(txs[txIndex]),
    leafIndex: witness.leafIndex,
    siblingPath: witness.siblingPath.toFields(),
  };
  return { txs, hints };
}

async function makeBlock(numTxs: number, txIndex: number, shape: Parameters<typeof TxEffect.random>[0] = {}) {
  const txs = await Promise.all(
    Array.from({ length: numTxs }, () => TxEffect.random({ maxEffects: 2, numPublicCallsPerTx: 0, ...shape })),
  );
  return makeBlockOf(txs, txIndex);
}

function expectSameEffect(actual: TeeTxEffect, expected: TxEffect) {
  expect(actual.txHash).toEqual(expected.txHash);
  expect(actual.noteHashes).toEqual(expected.noteHashes);
  expect(actual.nullifiers).toEqual(expected.nullifiers);
  expect(actual.l2ToL1Msgs).toEqual(expected.l2ToL1Msgs);
  expect(actual.privateLogs.map(log => log.toBlobFields())).toEqual(
    expected.privateLogs.map(log => log.toBlobFields()),
  );
}

function verifyAtAnchor(hints: TxEffectsHints) {
  return verifyAndDecodeTxEffectsAtAnchor(
    { txEffectsHints: hints, anchorRelation: { kind: 'txBlockIsAnchor' } },
    testConstrained(hints.txBlockHeader),
  );
}

function verifyInBlock(hints: TxEffectsHints) {
  return verifyTxEffectInBlock(hints, testConstrained(hints.txBlockHeader));
}

function withEffect(hints: TxEffectsHints, patch: Partial<TxEffectHintData>): TxEffectsHints {
  return { ...hints, txEffect: { ...hints.txEffect, ...patch } };
}

describe('tx effects tree proof', () => {
  it.each([
    { numTxs: 1, txIndex: 0 },
    { numTxs: 2, txIndex: 1 },
    { numTxs: 5, txIndex: 0 },
    { numTxs: 5, txIndex: 4 },
  ])('verifies tx $txIndex of a $numTxs-tx block at the anchor', async ({ numTxs, txIndex }) => {
    const { txs, hints } = await makeBlock(numTxs, txIndex);
    const parsed = await TxEffectsHintsSchema.parseAsync(JSON.parse(jsonStringify(hints)));
    expectSameEffect(await verifyAtAnchor(parsed), txs[txIndex]);
  });

  it('verifies a tx with every effect category populated', async () => {
    const { txs, hints } = await makeBlock(3, 1, FULL_TX_SHAPE);
    const parsed = await TxEffectsHintsSchema.parseAsync(JSON.parse(jsonStringify(hints)));
    expectSameEffect(await verifyAtAnchor(parsed), txs[1]);
  });

  it('verifies a reverted tx', async () => {
    const reverted = TxEffect.from({ ...(await TxEffect.random(FULL_TX_SHAPE)), revertCode: RevertCode.fromNumber(1) });
    const { txs, hints } = await makeBlockOf([await TxEffect.random(), reverted], 1);
    expectSameEffect(await verifyAtAnchor(hints), txs[1]);
  });

  it('verifies effects through both archive-proof entry points', async () => {
    const { txs, hints } = await makeBlock(3, 2);
    const proof = await archiveProof(hints.txBlockHeader);
    const anchorBlockHeader = BlockHeader.empty({
      lastArchive: new AppendOnlyTreeSnapshot(proof.root, TreeLeafIndex(4)),
      globalVariables: GlobalVariables.empty({ blockNumber: BlockNumber(4), slotNumber: SlotNumber(3) }),
    });

    const atAnchor = await verifyAndDecodeTxEffectsAtAnchor(
      {
        txEffectsHints: hints,
        anchorRelation: { kind: 'txBlockIsAncestorOfAnchor', archiveMembershipWitness: proof.witness },
      },
      testConstrained(anchorBlockHeader),
    );
    expectSameEffect(atAnchor, txs[2]);

    const archived = await verifyAndDecodeArchivedTxEffects(
      { archiveMembershipWitness: proof.witness, txEffectsHints: hints },
      testConstrained(proof.root),
    );
    expectSameEffect(archived.txEffect, txs[2]);
    expect(archived.txBlockHeader).toBe(hints.txBlockHeader);
  });

  it('rejects a tx block that is neither the anchor nor its ancestor', async () => {
    const { hints } = await makeBlock(2, 0);
    const other = BlockHeader.empty({
      globalVariables: GlobalVariables.empty({ blockNumber: BlockNumber(9), slotNumber: SlotNumber(9) }),
    });
    await expect(
      verifyAndDecodeTxEffectsAtAnchor(
        { txEffectsHints: hints, anchorRelation: { kind: 'txBlockIsAnchor' } },
        testConstrained(other),
      ),
    ).rejects.toThrow('differs from the anchor block hash');
    const proof = await archiveProof(other);
    await expect(
      verifyAndDecodeArchivedTxEffects(
        { archiveMembershipWitness: proof.witness, txEffectsHints: hints },
        testConstrained(proof.root),
      ),
    ).rejects.toThrow('Membership witness verification failed for block hash');
  });

  it('rejects a header whose tx effects tree root differs', async () => {
    const { hints } = await makeBlock(2, 0);
    hints.txBlockHeader = BlockHeader.empty({
      txEffectsTreeRoot: Fr.random(),
      globalVariables: hints.txBlockHeader.globalVariables,
    });
    await expect(verifyInBlock(hints)).rejects.toThrow('tx effects tree leaf');
  });

  it('rejects a tampered scalar, field or opaque category hash', async () => {
    const { hints } = await makeBlock(2, 0, FULL_TX_SHAPE);
    const e = hints.txEffect;
    const bump = (f: Fr) => f.add(Fr.ONE);
    const tampered: Record<string, Partial<TxEffectHintData>> = {
      txStartMarker: { txStartMarker: bump(e.txStartMarker) },
      txHash: { txHash: bump(e.txHash) },
      transactionFee: { transactionFee: bump(e.transactionFee) },
      noteHashes: { noteHashes: [bump(e.noteHashes[0]), ...e.noteHashes.slice(1)] },
      nullifiers: { nullifiers: [bump(e.nullifiers[0]), ...e.nullifiers.slice(1)] },
      l2ToL1Msgs: { l2ToL1Msgs: [bump(e.l2ToL1Msgs[0]), ...e.l2ToL1Msgs.slice(1)] },
      privateLogs: {
        privateLogs: [
          [e.privateLogs[0][0], bump(e.privateLogs[0][1]), ...e.privateLogs[0].slice(2)],
          ...e.privateLogs.slice(1),
        ],
      },
      publicDataWritesHash: { publicDataWritesHash: bump(e.publicDataWritesHash) },
      publicLogsHash: { publicLogsHash: bump(e.publicLogsHash) },
      contractClassLogHash: { contractClassLogHash: bump(e.contractClassLogHash) },
    };
    const accepted: string[] = [];
    for (const [name, patch] of Object.entries(tampered)) {
      await verifyInBlock(withEffect(hints, patch)).then(
        () => accepted.push(name),
        () => undefined,
      );
    }
    expect(accepted).toEqual([]);
  });

  it('rejects counts that disagree with the start marker', async () => {
    const { hints } = await makeBlock(2, 0, FULL_TX_SHAPE);
    const e = hints.txEffect;
    await expect(verifyInBlock(withEffect(hints, { nullifiers: e.nullifiers.slice(1) }))).rejects.toThrow(
      'Failed to decode tx effect hint: nullifiers',
    );
    await expect(verifyInBlock(withEffect(hints, { privateLogs: [...e.privateLogs, [Fr.ONE]] }))).rejects.toThrow(
      'Failed to decode tx effect hint: privateLogs',
    );
    await expect(verifyInBlock(withEffect(hints, { txStartMarker: Fr.random() }))).rejects.toThrow(
      'invalid tx start marker',
    );
  });

  it('rejects the effects of one tx with the path of another', async () => {
    const { txs, hints } = await makeBlock(3, 1);
    await expect(verifyInBlock({ ...hints, txEffect: await toTxEffectHintData(txs[2]) })).rejects.toThrow(
      'tx effects tree leaf',
    );
  });

  it('rejects a shortened path that presents an internal node as the root', async () => {
    const { hints } = await makeBlock(4, 0);
    expect(hints.siblingPath.length).toBe(2);
    await expect(verifyInBlock({ ...hints, siblingPath: hints.siblingPath.slice(0, -1) })).rejects.toThrow(
      'tx effects tree leaf',
    );
    await expect(
      verifyInBlock({ ...hints, siblingPath: hints.siblingPath.slice(1), leafIndex: hints.leafIndex >> 1n }),
    ).rejects.toThrow('tx effects tree leaf');
  });

  it('rejects a leaf index outside the path range', async () => {
    const { hints } = await makeBlock(4, 0);
    const outside = 1n << BigInt(hints.siblingPath.length);
    await expect(verifyInBlock({ ...hints, leafIndex: hints.leafIndex + outside })).rejects.toThrow('out of range');
    await expect(verifyInBlock({ ...hints, leafIndex: -1n })).rejects.toThrow('out of range');
  });

  it('rejects a mismatched leaf index for a valid path', async () => {
    const { hints } = await makeBlock(4, 0);
    await expect(verifyInBlock({ ...hints, leafIndex: hints.leafIndex ^ 1n })).rejects.toThrow('tx effects tree leaf');
  });

  it('does not deserialize legacy hints', async () => {
    const { txs, hints } = await makeBlock(2, 1);
    const legacy = {
      ...hints,
      txBlobFields: txs[1].toBlobFields(),
      checkpointBlobFields: [Fr.ONE],
      previousBlockHeader: hints.txBlockHeader,
      txBlockStartOffset: 0,
      txIndexInBlock: 1,
    };
    const parsed = await TxEffectsHintsSchema.parseAsync(JSON.parse(jsonStringify(legacy)));
    expect(parsed).not.toHaveProperty('txBlobFields');
    expect(parsed).not.toHaveProperty('checkpointBlobFields');
    await expect(verifyAtAnchor(parsed)).resolves.toBeDefined();
  });
});
