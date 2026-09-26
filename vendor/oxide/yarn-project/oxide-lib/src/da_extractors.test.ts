import { Fr } from '@aztec/aztec.js/fields';
import { MAX_L2_TO_L1_MSGS_PER_TX, MAX_NULLIFIERS_PER_TX, PRIVATE_LOG_SIZE_IN_FIELDS } from '@aztec/constants';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { PrivateLog, SiloedTag, Tag } from '@aztec/stdlib/logs';
import { TxEffect } from '@aztec/stdlib/tx';

import { beforeAll, describe, expect, it } from '@jest/globals';

import { extractMetadata, extractRequiredNullifiers, extractWithdrawalMessageHashes } from './da_extractors.js';
import {
  TEE_METADATA_DA_TAG,
  TEE_REQUIRED_NULLIFIERS_DA_TAG,
  TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG,
} from './oxide_constants.gen.js';

// These tests are mirrored in noir-projects/oxide_token_contract/src/da.nr: every case here has a same-named test there
// with equivalent behavior. This helps ensure the enclave and the client perform equivalent validation checks.

// Layout mirrors da.nr: fields[0] the siloed DA tag, fields[1..5] the 5 metadata payload fields.
const METADATA_PAYLOAD = [11, 12, 13, 14, 15].map(n => new Fr(n));
const TWO_POW_128 = 1n << 128n;

let l2Token: AztecAddress;
let siloedMetadataTag: Fr;
let siloedRequiredNullifiersTag: Fr;
let siloedWithdrawalMessageHashesTag: Fr;

async function siloTag(tag: bigint, token: AztecAddress): Promise<Fr> {
  return (await SiloedTag.computeFromTagAndApp(new Tag(new Fr(tag)), token)).value;
}

beforeAll(async () => {
  l2Token = await AztecAddress.random();
  siloedMetadataTag = await siloTag(TEE_METADATA_DA_TAG, l2Token);
  siloedRequiredNullifiersTag = await siloTag(TEE_REQUIRED_NULLIFIERS_DA_TAG, l2Token);
  siloedWithdrawalMessageHashesTag = await siloTag(TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG, l2Token);
});

function metadataLog(emittedLength: number, payload: Fr[] = METADATA_PAYLOAD): PrivateLog {
  const fields = Array.from({ length: PRIVATE_LOG_SIZE_IN_FIELDS }, () => Fr.ZERO);
  fields[0] = siloedMetadataTag;
  payload.forEach((f, i) => (fields[i + 1] = f));
  return new PrivateLog(fields as PrivateLog['fields'], emittedLength);
}

function daLog(siloedTag: Fr, payload: Fr[], emittedLength = payload.length + 1): PrivateLog {
  const fields = Array.from({ length: PRIVATE_LOG_SIZE_IN_FIELDS }, () => Fr.ZERO);
  fields[0] = siloedTag;
  payload.forEach((f, i) => (fields[i + 1] = f));
  return new PrivateLog(fields as PrivateLog['fields'], emittedLength);
}

/** The `count` fields `first, first + 1, ...`. */
function counting(first: number, count: number): Fr[] {
  return Array.from({ length: count }, (_, i) => new Fr(first + i));
}

function effectWith(...logs: PrivateLog[]): TxEffect {
  const effect = TxEffect.empty();
  effect.privateLogs = logs;
  return effect;
}

describe('metadata', () => {
  it('reads a fully emitted log', async () => {
    const metadata = await extractMetadata(effectWith(metadataLog(6)), l2Token);
    const got = [
      metadata.pubKeyXHi,
      metadata.pubKeyXLo,
      metadata.pubKeyYHi,
      metadata.pubKeyYLo,
      metadata.anchorBlockHash,
    ].map(f => f.toString());
    expect(got).toEqual(METADATA_PAYLOAD.map(f => f.toString()));
  });

  it('rejects a tag in unauthenticated padding', async () => {
    // Siloed tag sits at index 0 but is not emitted, so it must not be found.
    await expect(extractMetadata(effectWith(metadataLog(0)), l2Token)).rejects.toThrow(/found 0/);
  });

  it('rejects a payload not fully emitted', async () => {
    // Tag is emitted but some of the 5 payload fields live in padding beyond emittedLength.
    for (let emitted = 1; emitted < 6; emitted++) {
      await expect(extractMetadata(effectWith(metadataLog(emitted)), l2Token)).rejects.toThrow(
        /not fully emitted|need at least/,
      );
    }
  });

  it('ignores a log of another token', async () => {
    const otherToken = await AztecAddress.random();
    await expect(extractMetadata(effectWith(metadataLog(6)), otherToken)).rejects.toThrow(/found 0/);
  });

  it('rejects two tagged logs', async () => {
    await expect(extractMetadata(effectWith(metadataLog(6), metadataLog(6)), l2Token)).rejects.toThrow(/found 2/);
  });

  it('reads key halves at the 16-byte boundary', async () => {
    const maxHalf = new Fr(TWO_POW_128 - 1n);
    const metadata = await extractMetadata(
      effectWith(metadataLog(6, [maxHalf, maxHalf, maxHalf, maxHalf, new Fr(15)])),
      l2Token,
    );
    expect(metadata.pubKeyYLo.equals(maxHalf)).toBe(true);
  });

  it('rejects a key half wider than 16 bytes', async () => {
    for (let wideIndex = 0; wideIndex < 4; wideIndex++) {
      const payload = [...METADATA_PAYLOAD];
      payload[wideIndex] = new Fr(payload[wideIndex].toBigInt() + TWO_POW_128);
      await expect(extractMetadata(effectWith(metadataLog(6, payload)), l2Token)).rejects.toThrow(/exceeds 16 bytes/);
    }
  });
});

describe('DA set', () => {
  it('reads the emitted payload', async () => {
    const payload = [1, 2, 3].map(n => new Fr(n));
    const got = await extractRequiredNullifiers(effectWith(daLog(siloedRequiredNullifiersTag, payload)), l2Token);
    expect(got.map(f => f.toString())).toEqual(payload.map(f => f.toString()));
  });

  it('reads a trailing zero as an element', async () => {
    // A submitter can emit the signed set's own zero padding as an extra element; nothing in the log distinguishes
    // the two. The digest, which covers the element count, is what rejects it.
    const payload = [new Fr(1), new Fr(2), Fr.ZERO];
    const got = await extractRequiredNullifiers(effectWith(daLog(siloedRequiredNullifiersTag, payload)), l2Token);
    expect(got.length).toBe(3);
  });

  it('ignores a tag in unauthenticated padding', async () => {
    const got = await extractRequiredNullifiers(
      effectWith(daLog(siloedRequiredNullifiersTag, counting(1, 3), 0)),
      l2Token,
    );
    expect(got.length).toBe(0);
  });

  it('reads exactly the per-tx cap', async () => {
    const payload = counting(1, MAX_L2_TO_L1_MSGS_PER_TX);
    const got = await extractWithdrawalMessageHashes(
      effectWith(daLog(siloedWithdrawalMessageHashesTag, payload)),
      l2Token,
    );
    expect(got.map(f => f.toString())).toEqual(payload.map(f => f.toString()));
  });

  it('rejects more elements than the per-tx cap', async () => {
    const payload = counting(1, MAX_L2_TO_L1_MSGS_PER_TX + 1);
    await expect(
      extractWithdrawalMessageHashes(effectWith(daLog(siloedWithdrawalMessageHashesTag, payload)), l2Token),
    ).rejects.toThrow(/Too many withdrawal message hashes/);
  });

  it('rejects the cap exceeded across two logs', async () => {
    await expect(
      extractWithdrawalMessageHashes(
        effectWith(
          daLog(siloedWithdrawalMessageHashesTag, counting(1, MAX_L2_TO_L1_MSGS_PER_TX)),
          daLog(siloedWithdrawalMessageHashesTag, [new Fr(0xdead)]),
        ),
        l2Token,
      ),
    ).rejects.toThrow(/Too many withdrawal message hashes/);
  });

  it('reads a cap spread across full logs', async () => {
    const full = PRIVATE_LOG_SIZE_IN_FIELDS - 1;
    const rest = MAX_NULLIFIERS_PER_TX - 4 * full;
    const logs = [0, 1, 2, 3].map(i => daLog(siloedRequiredNullifiersTag, counting(1 + i * full, full)));
    logs.push(daLog(siloedRequiredNullifiersTag, counting(1 + 4 * full, rest)));
    const got = await extractRequiredNullifiers(effectWith(...logs), l2Token);
    expect(got.length).toBe(MAX_NULLIFIERS_PER_TX);
    expect(got[MAX_NULLIFIERS_PER_TX - 1].toNumber()).toBe(MAX_NULLIFIERS_PER_TX);
  });

  it('rejects a cap spread across full logs exceeded by one', async () => {
    const full = PRIVATE_LOG_SIZE_IN_FIELDS - 1;
    const rest = MAX_NULLIFIERS_PER_TX - 4 * full;
    const logs = [0, 1, 2, 3].map(i => daLog(siloedRequiredNullifiersTag, counting(1 + i * full, full)));
    logs.push(daLog(siloedRequiredNullifiersTag, counting(1 + 4 * full, rest + 1)));
    await expect(extractRequiredNullifiers(effectWith(...logs), l2Token)).rejects.toThrow(
      /Too many required nullifiers/,
    );
  });
});
