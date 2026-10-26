import { encodeTxStartMarker } from '@aztec-labs/blob-lib/encoding';
import { PRIVATE_LOG_SIZE_IN_FIELDS } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { RevertCode } from '@aztec-labs/stdlib/avm';
import { TxEffect } from '@aztec-labs/stdlib/tx';

import { describe, expect, it } from '@jest/globals';

import { computeTxEffectLeafFromHint, decodeTxEffectHint, toTxEffectHintData } from './tx_effect_hint.js';
import { TxEffectHintDataSchema } from './types.js';

const SHAPES = {
  minimal: {
    numNoteHashes: 0,
    numNullifiers: 1,
    numL2ToL1Msgs: 0,
    numPublicDataWrites: 0,
    numPrivateLogs: 0,
    numPublicCallsPerTx: 0,
    numContractClassLogs: 0,
  },
  typical: {
    numNoteHashes: 2,
    numNullifiers: 2,
    numL2ToL1Msgs: 1,
    numPublicDataWrites: 1,
    numPrivateLogs: 3,
    numPublicCallsPerTx: 0,
    numContractClassLogs: 0,
  },
  full: {
    numNoteHashes: 2,
    numNullifiers: 2,
    numL2ToL1Msgs: 1,
    numPublicDataWrites: 2,
    numPrivateLogs: 2,
    numPublicCallsPerTx: 1,
    numPublicLogsPerCall: 1,
    numContractClassLogs: 1,
  },
  maximal: {
    numNoteHashes: 64,
    numNullifiers: 64,
    numL2ToL1Msgs: 8,
    numPublicDataWrites: 64,
    numPrivateLogs: 64,
    numPublicCallsPerTx: 1,
    numPublicLogsPerCall: 1,
    numContractClassLogs: 1,
  },
};

const blobLogs = (logs: { toBlobFields(): Fr[] }[]) => logs.map(log => log.toBlobFields());

describe('tx effect hint', () => {
  it.each(Object.entries(SHAPES))('matches the stdlib leaf for a %s tx', async (_, shape) => {
    const effect = await TxEffect.random(shape);
    const data = await toTxEffectHintData(effect);
    expect(await computeTxEffectLeafFromHint(data)).toEqual(await effect.computeTxEffectsTreeLeaf());
  });

  it('matches the stdlib leaf for a reverted tx', async () => {
    const effect = TxEffect.from({ ...(await TxEffect.random(SHAPES.full)), revertCode: RevertCode.fromNumber(1) });
    const data = await toTxEffectHintData(effect);
    expect(await computeTxEffectLeafFromHint(data)).toEqual(await effect.computeTxEffectsTreeLeaf());
  });

  it('round-trips through the schema and decodes to the view the enclave reads', async () => {
    const effect = await TxEffect.random(SHAPES.full);
    const data = await TxEffectHintDataSchema.parseAsync(JSON.parse(jsonStringify(await toTxEffectHintData(effect))));
    const view = decodeTxEffectHint(data);
    expect(view.txHash).toEqual(effect.txHash);
    expect(view.noteHashes).toEqual(effect.noteHashes);
    expect(view.nullifiers).toEqual(effect.nullifiers);
    expect(view.l2ToL1Msgs).toEqual(effect.l2ToL1Msgs);
    expect(blobLogs(view.privateLogs)).toEqual(blobLogs(effect.privateLogs));
    expect(view.privateLogs.map(log => log.emittedLength)).toEqual(effect.privateLogs.map(log => log.emittedLength));
    expect(await computeTxEffectLeafFromHint(data)).toEqual(await effect.computeTxEffectsTreeLeaf());
  });

  it('rejects a count that differs from the start marker', async () => {
    const data = await toTxEffectHintData(await TxEffect.random(SHAPES.typical));
    expect(() => decodeTxEffectHint({ ...data, nullifiers: data.nullifiers.slice(1) })).toThrow(
      'nullifiers: 1 sent, tx start marker declares 2',
    );
    expect(() => decodeTxEffectHint({ ...data, noteHashes: [...data.noteHashes, Fr.ONE] })).toThrow('noteHashes');
    expect(() => decodeTxEffectHint({ ...data, l2ToL1Msgs: [] })).toThrow('l2ToL1Msgs');
    expect(() => decodeTxEffectHint({ ...data, privateLogs: data.privateLogs.slice(1) })).toThrow('privateLogs');
    const shortened = data.privateLogs.map((log, i) => (i === 0 ? log.slice(1) : log));
    expect(() => decodeTxEffectHint({ ...data, privateLogs: shortened })).toThrow('privateLogs fields');
  });

  it('rejects a private log longer than the protocol size', async () => {
    const data = await toTxEffectHintData(await TxEffect.random(SHAPES.minimal));
    const log = Array.from({ length: PRIVATE_LOG_SIZE_IN_FIELDS + 1 }, () => Fr.random());
    const txStartMarker = encodeTxStartMarker({
      numBlobFields: 4 + 1 + log.length,
      revertCode: 0,
      numNoteHashes: 0,
      numNullifiers: 1,
      numL2ToL1Msgs: 0,
      numPublicDataWrites: 0,
      numPrivateLogs: 1,
      privateLogsLength: log.length,
      publicLogsLength: 0,
      contractClassLogLength: 0,
    });
    expect(() => decodeTxEffectHint({ ...data, txStartMarker, privateLogs: [log] })).toThrow('maximum is 16');
  });

  it('rejects a field that is not a tx start marker', async () => {
    const data = await toTxEffectHintData(await TxEffect.random(SHAPES.typical));
    expect(() => decodeTxEffectHint({ ...data, txStartMarker: Fr.random() })).toThrow('invalid tx start marker');
  });
});
