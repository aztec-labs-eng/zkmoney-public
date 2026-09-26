import { SpongeBlob } from '@aztec/blob-lib';
import { encodeBlockBlobData, makeBlockBlobData } from '@aztec/blob-lib/encoding';
import { ARCHIVE_HEIGHT, DomainSeparator } from '@aztec/constants';
import { makeTuple } from '@aztec/foundation/array';
import { BlockNumber, SlotNumber } from '@aztec/foundation/branded-types';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import { MembershipWitness } from '@aztec/foundation/trees';
import { AppendOnlyTreeSnapshot } from '@aztec/stdlib/trees';
import { BlockHeader, GlobalVariables, TxEffect } from '@aztec/stdlib/tx';

import { type Constrained, testConstrained } from '@oxide/oxide-lib/constrained.js';
import { type TxEffectsHints, TxEffectsHintsSchema } from '@oxide/oxide-lib/types.js';

import { describe, expect, it } from '@jest/globals';

import {
  verifyAndDecodeArchivedTxEffects,
  verifyAndDecodeBlockBlobFields,
  verifyAndDecodeTxEffectsAtAnchor,
} from './verify_and_decode_tx_effects.js';

function initSponge(): Constrained<SpongeBlob> {
  return testConstrained(SpongeBlob.init());
}

async function spongeHash(fields: Fr[]): Promise<Constrained<Fr>> {
  const sponge = SpongeBlob.init();
  await sponge.absorb(fields);
  return testConstrained(await sponge.squeeze());
}

describe('verifyAndDecodeBlockBlobFields', () => {
  const blockBlobData = makeBlockBlobData({ numTxs: 2, isFirstBlock: true });
  const fields = encodeBlockBlobData(blockBlobData);

  it('decodes a stream that matches the expected sponge blob hash', async () => {
    const decoded = await verifyAndDecodeBlockBlobFields(initSponge(), fields, true, await spongeHash(fields));
    expect(decoded.txs.length).toBe(2);
    expect(encodeBlockBlobData(decoded)).toEqual(fields);
  });

  it('rejects a stream whose sponge blob hash does not match', async () => {
    await expect(
      verifyAndDecodeBlockBlobFields(initSponge(), fields, true, testConstrained(Fr.random())),
    ).rejects.toThrow('Sponge blob hash mismatch');
  });

  it('rejects trailing fields even when the sponge blob hash matches', async () => {
    // squeeze() does not bind the absorbed field count, so a hash over a zero-extended stream can collide with the
    // committed one; the exhaustion check must reject the extension regardless.
    const extended = [...fields, Fr.ZERO];
    await expect(
      verifyAndDecodeBlockBlobFields(initSponge(), extended, true, await spongeHash(extended)),
    ).rejects.toThrow('trailing fields');
  });

  it('rejects a truncated stream with a decode error', async () => {
    const truncated = fields.slice(0, -1);
    await expect(
      verifyAndDecodeBlockBlobFields(initSponge(), truncated, true, await spongeHash(truncated)),
    ).rejects.toThrow('Failed to decode verified block blob fields');
  });
});

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

async function makeHints(firstInCheckpoint = false, opaquePrefixLength = 0) {
  const precedingBlocks = [
    makeBlockBlobData({ numTxs: 1, isFirstBlock: true, seed: 1 }),
    makeBlockBlobData({ numTxs: 1, isFirstBlock: false, seed: 2 }),
  ];
  const previousBlocksBlobFields = firstInCheckpoint
    ? []
    : opaquePrefixLength > 0
      ? Array.from({ length: opaquePrefixLength }, (_, i) => new Fr(i + 1))
      : precedingBlocks.flatMap(encodeBlockBlobData);
  const blockBlobData = makeBlockBlobData({
    numTxs: 2,
    isFirstBlock: firstInCheckpoint,
    seed: 3,
    blockEndMarker: { blockNumber: BlockNumber(3), numTxs: 2 },
  });
  blockBlobData.txs = await Promise.all(
    [0, 1].map(async () => (await TxEffect.random({ maxEffects: 2, numPublicCallsPerTx: 0 })).toTxBlobData()),
  );
  const blockBlobFields = encodeBlockBlobData(blockBlobData);
  const previousBlockHeader = BlockHeader.empty({
    globalVariables: GlobalVariables.empty({
      blockNumber: BlockNumber(2),
      slotNumber: SlotNumber(firstInCheckpoint ? 1 : 2),
    }),
    spongeBlobHash: await spongeHash(previousBlocksBlobFields),
  });
  const previousProof = await archiveProof(previousBlockHeader);
  const txBlockHeader = BlockHeader.empty({
    lastArchive: new AppendOnlyTreeSnapshot(previousProof.root, 3),
    globalVariables: GlobalVariables.empty({ blockNumber: BlockNumber(3), slotNumber: SlotNumber(2) }),
    spongeBlobHash: await spongeHash([...previousBlocksBlobFields, ...blockBlobFields]),
  });
  const hints: TxEffectsHints = {
    txBlockHeader,
    previousBlockHeader,
    previousBlockArchiveMembershipWitness: previousProof.witness,
    checkpointBlobFields: [...previousBlocksBlobFields, ...blockBlobFields],
    txBlockStartOffset: previousBlocksBlobFields.length,
    txIndexInBlock: 0,
  };
  return { hints, blockBlobData };
}

function verifyAtAnchor(hints: TxEffectsHints) {
  return verifyAndDecodeTxEffectsAtAnchor(
    { txEffectsHints: hints, anchorRelation: { kind: 'txBlockIsAnchor' } },
    testConstrained(hints.txBlockHeader),
  );
}

describe('checkpoint replay for tx effects', () => {
  it.each([true, false])('verifies target effects at the anchor (first in checkpoint: %s)', async first => {
    const { hints, blockBlobData } = await makeHints(first);
    const parsed = await TxEffectsHintsSchema.parseAsync(JSON.parse(jsonStringify(hints)));
    const effect = await verifyAtAnchor(parsed);
    expect(effect.toBuffer()).toEqual(TxEffect.fromTxBlobData(blockBlobData.txs[0]).toBuffer());
  });

  it('does not decode the preceding fields', async () => {
    const { hints, blockBlobData } = await makeHints(false, 3);
    const effect = await verifyAtAnchor(hints);
    expect(effect.toBuffer()).toEqual(TxEffect.fromTxBlobData(blockBlobData.txs[0]).toBuffer());
  });

  it('verifies effects through both archive-proof entry points', async () => {
    const { hints, blockBlobData } = await makeHints();
    // Put the two headers at adjacent archive leaves and give them a shared path above their parent.
    const previousHash = new Fr((await hints.previousBlockHeader.hash()).toBuffer());
    const txHash = new Fr((await hints.txBlockHeader.hash()).toBuffer());
    let root = await poseidon2HashWithSeparator([previousHash, txHash], DomainSeparator.MERKLE_HASH);
    let index = 1n;
    for (let level = 1; level < ARCHIVE_HEIGHT; level++) {
      const pair = (index & 1n) === 0n ? [root, Fr.ZERO] : [Fr.ZERO, root];
      root = await poseidon2HashWithSeparator(pair, DomainSeparator.MERKLE_HASH);
      index >>= 1n;
    }
    hints.previousBlockArchiveMembershipWitness = new MembershipWitness(
      ARCHIVE_HEIGHT,
      2n,
      makeTuple(ARCHIVE_HEIGHT, i => (i === 0 ? txHash : Fr.ZERO)),
    );
    const witness = new MembershipWitness(
      ARCHIVE_HEIGHT,
      3n,
      makeTuple(ARCHIVE_HEIGHT, i => (i === 0 ? previousHash : Fr.ZERO)),
    );
    const archived = await verifyAndDecodeArchivedTxEffects(
      { txEffectsHints: hints, archiveMembershipWitness: witness },
      testConstrained(root),
    );
    expect(archived.txEffect.toBuffer()).toEqual(TxEffect.fromTxBlobData(blockBlobData.txs[0]).toBuffer());
    const anchor = BlockHeader.empty({ lastArchive: new AppendOnlyTreeSnapshot(root, 4) });
    const ancestor = await verifyAndDecodeTxEffectsAtAnchor(
      {
        txEffectsHints: hints,
        anchorRelation: { kind: 'txBlockIsAncestorOfAnchor', archiveMembershipWitness: witness },
      },
      testConstrained(anchor),
    );
    expect(ancestor.toBuffer()).toEqual(archived.txEffect.toBuffer());
  });

  it.each([1, 2])('rejects an altered first transaction field at offset %s', async offset => {
    const { hints } = await makeHints();
    expect(hints.txBlockStartOffset % 3).toBe(0);
    hints.checkpointBlobFields[hints.txBlockStartOffset + offset] = hints.checkpointBlobFields[
      hints.txBlockStartOffset + offset
    ].add(Fr.ONE);
    await expect(verifyAtAnchor(hints)).rejects.toThrow('Sponge blob hash mismatch');
  });

  it('rejects altered preceding fields', async () => {
    const { hints } = await makeHints();
    hints.checkpointBlobFields[1] = Fr.ZERO;
    await expect(verifyAtAnchor(hints)).rejects.toThrow('Previous blocks blob hash mismatch');
  });

  it('rejects an omitted checkpoint prefix', async () => {
    const { hints } = await makeHints();
    hints.checkpointBlobFields = hints.checkpointBlobFields.slice(hints.txBlockStartOffset);
    hints.txBlockStartOffset = 0;
    await expect(verifyAtAnchor(hints)).rejects.toThrow('Previous blocks blob hash mismatch');
  });

  it('rejects a changed split even when the combined field stream is unchanged', async () => {
    const { hints } = await makeHints();
    hints.txBlockStartOffset++;
    await expect(verifyAtAnchor(hints)).rejects.toThrow('Previous blocks blob hash mismatch');
  });

  it('rejects zero extension of the prefix even if the predecessor hash is unchanged', async () => {
    const { hints } = await makeHints(false, 1);
    hints.checkpointBlobFields.splice(hints.txBlockStartOffset, 0, Fr.ZERO);
    hints.txBlockStartOffset++;
    // The squeeze does not bind the field count. The target hash must still match after continuation.
    expect(await spongeHash(hints.checkpointBlobFields.slice(0, hints.txBlockStartOffset))).toEqual(
      hints.previousBlockHeader.spongeBlobHash,
    );
    await expect(verifyAtAnchor(hints)).rejects.toThrow('Sponge blob hash mismatch');
  });

  it('requires an empty prefix at the start of a checkpoint', async () => {
    const { hints } = await makeHints(true);
    hints.txBlockStartOffset = 1;
    await expect(verifyAtAnchor(hints)).rejects.toThrow('must have txBlockStartOffset 0');
  });

  it('rejects an unauthenticated predecessor header', async () => {
    const { hints } = await makeHints();
    hints.previousBlockHeader = BlockHeader.empty();
    await expect(verifyAtAnchor(hints)).rejects.toThrow('Membership witness verification failed');
  });

  it('rejects a valid archive proof for a non-immediate predecessor', async () => {
    const { hints } = await makeHints();
    hints.previousBlockHeader = BlockHeader.empty({
      globalVariables: GlobalVariables.empty({ blockNumber: BlockNumber(1), slotNumber: SlotNumber(2) }),
    });
    const proof = await archiveProof(hints.previousBlockHeader);
    hints.previousBlockArchiveMembershipWitness = proof.witness;
    hints.txBlockHeader = BlockHeader.empty({
      ...hints.txBlockHeader,
      lastArchive: new AppendOnlyTreeSnapshot(proof.root, 3),
    });
    await expect(verifyAtAnchor(hints)).rejects.toThrow('not the immediate predecessor');
  });

  it.each([-1, 2])('rejects an out-of-range transaction index %s', async txIndexInBlock => {
    const { hints } = await makeHints();
    hints.txIndexInBlock = txIndexInBlock;
    await expect(verifyAtAnchor(hints)).rejects.toThrow('is out of range');
  });

  it.each([-1, 0.5, NaN, Infinity, 2 ** 32])('rejects invalid target offset %s', async txBlockStartOffset => {
    const { hints } = await makeHints();
    hints.txBlockStartOffset = txBlockStartOffset;
    await expect(verifyAtAnchor(hints)).rejects.toThrow('txBlockStartOffset');
    await expect(TxEffectsHintsSchema.parseAsync(JSON.parse(jsonStringify(hints)))).rejects.toThrow();
  });

  it('rejects a target offset at the end of the array', async () => {
    const { hints } = await makeHints();
    hints.txBlockStartOffset = hints.checkpointBlobFields.length;
    await expect(verifyAtAnchor(hints)).rejects.toThrow('txBlockStartOffset');
  });

  it('does not deserialize a legacy sponge-state hint', async () => {
    const { hints } = await makeHints();
    const parsed = await TxEffectsHintsSchema.parseAsync(
      JSON.parse(jsonStringify({ ...hints, previousBlockEndSpongeBlob: { invalid: true } })),
    );
    expect(parsed).not.toHaveProperty('previousBlockEndSpongeBlob');
    await expect(verifyAtAnchor(parsed)).resolves.toBeDefined();
  });
});
