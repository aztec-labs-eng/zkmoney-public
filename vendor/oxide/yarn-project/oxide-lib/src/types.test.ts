import { Fr } from '@aztec/aztec.js/fields';
import { SpongeBlob } from '@aztec/blob-lib';
import {
  ARCHIVE_HEIGHT,
  L1_TO_L2_MSG_TREE_HEIGHT,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  NULLIFIER_TREE_HEIGHT,
  PUBLIC_DATA_TREE_HEIGHT,
} from '@aztec/constants';
import { Point } from '@aztec/foundation/curves/grumpkin';
import { EthAddress } from '@aztec/foundation/eth-address';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import { MembershipWitness } from '@aztec/foundation/trees';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { NullifierMembershipWitness, PublicDataWitness } from '@aztec/stdlib/trees';

import { describe, expect, it } from '@jest/globals';

import {
  MAX_FROZEN_NOTES_PER_REFUND,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
} from './oxide_constants.gen.js';
import {
  FrozenDepositRefundFinalizationInputSchema,
  FrozenNotesRefundFinalizationInputSchema,
  NoteDataSchema,
  OutboxWithdrawalSchema,
  TokenOperationSchema,
  TxEffectsHintsSchema,
  UnprocessedDepositRefundFinalizationInputSchema,
  WithdrawalFinalizationInputSchema,
  archiveMembershipWitnessSchema,
  nullifierMembershipWitnessSchema,
  publicDataWitnessSchema,
} from './types.js';

const LEAF_INDEX_BYTES = 32;
const VECTOR_COUNT_BYTES = 4;
const ADDRESS_BYTES = AztecAddress.SIZE_IN_BYTES;
const ADDRESS_HEX_CHARS = 2 + 2 * ADDRESS_BYTES;
const ARCHIVE_BYTES = LEAF_INDEX_BYTES + ARCHIVE_HEIGHT * Fr.SIZE_IN_BYTES;
const NULLIFIER_PATH_BYTES = VECTOR_COUNT_BYTES + NULLIFIER_TREE_HEIGHT * Fr.SIZE_IN_BYTES;
const PUBLIC_DATA_PATH_BYTES = VECTOR_COUNT_BYTES + PUBLIC_DATA_TREE_HEIGHT * Fr.SIZE_IN_BYTES;

// A malicious caller can send arrays long enough that per-element Zod validation blows the error message past V8's max
// string length. The bounded-array caps reject an over-length array up front, before any element is validated,
// matching the protocol limits the signer enforces at runtime.
describe('attacker-controlled array caps', () => {
  it('rejects over-length TokenOperation arrays before validating elements', async () => {
    await expect(
      TokenOperationSchema.parseAsync({
        spentNotes: new Array(MAX_NULLIFIERS_PER_TX + 1).fill(null),
        createdNotes: [],
        deposits: [],
        withdrawals: [],
      }),
    ).rejects.toThrow(`spentNotes has ${MAX_NULLIFIERS_PER_TX + 1} entries, exceeds max ${MAX_NULLIFIERS_PER_TX}`);
  });

  it('caps each TokenOperation array at its own protocol limit', async () => {
    const cases: Array<[string, number]> = [
      ['createdNotes', MAX_NOTE_HASHES_PER_TX],
      ['deposits', MAX_NULLIFIERS_PER_TX],
      ['withdrawals', MAX_L2_TO_L1_MSGS_PER_TX],
    ];
    for (const [field, max] of cases) {
      const op = {
        spentNotes: [],
        createdNotes: [],
        deposits: [],
        withdrawals: [],
        [field]: new Array(max + 1).fill(null),
      };
      await expect(TokenOperationSchema.parseAsync(op)).rejects.toThrow(
        `${field} has ${max + 1} entries, exceeds max ${max}`,
      );
    }
  });

  it('caps FrozenNotesRefundFinalization arrays at MAX_FROZEN_NOTES_PER_REFUND', async () => {
    const over = new Array(MAX_FROZEN_NOTES_PER_REFUND + 1).fill(null);
    await expect(FrozenNotesRefundFinalizationInputSchema.parseAsync({ notes: over })).rejects.toThrow(
      `notes has ${MAX_FROZEN_NOTES_PER_REFUND + 1} entries, exceeds max ${MAX_FROZEN_NOTES_PER_REFUND}`,
    );
  });

  it('rejects an over-length checkpointBlobFields array before validating elements', async () => {
    const over = new Array(SpongeBlob.MAX_FIELDS + 1).fill(null);
    await expect(TxEffectsHintsSchema.parseAsync({ checkpointBlobFields: over })).rejects.toThrow(
      `checkpointBlobFields has ${SpongeBlob.MAX_FIELDS + 1} entries, exceeds max ${SpongeBlob.MAX_FIELDS}`,
    );
  });

  it('rejects an over-length deposit siblingPath before validating elements', async () => {
    const op = {
      spentNotes: [],
      createdNotes: [],
      deposits: [{ siblingPath: new Array(L1_TO_L2_MSG_TREE_HEIGHT + 1).fill(0) }],
      withdrawals: [],
    };
    await expect(TokenOperationSchema.parseAsync(op)).rejects.toThrow(
      `siblingPath has ${L1_TO_L2_MSG_TREE_HEIGHT + 1} entries, exceeds max ${L1_TO_L2_MSG_TREE_HEIGHT}`,
    );
  });

  // Witness buffers arrive as `{ type: 'Buffer', data: [...] }`, whose bytes upstream validates one at a time.
  it('caps witness buffer byte arrays before validating bytes', async () => {
    const bytes = (n: number) => ({ type: 'Buffer', data: new Array(n).fill(-1) });

    await expect(
      WithdrawalFinalizationInputSchema.parseAsync({ hints: { archiveMembershipWitness: bytes(ARCHIVE_BYTES + 1) } }),
    ).rejects.toThrow(`archiveMembershipWitness has ${ARCHIVE_BYTES + 1} bytes, exceeds max ${ARCHIVE_BYTES}`);

    await expect(
      FrozenDepositRefundFinalizationInputSchema.parseAsync({
        lowNullifierMembershipWitness: { siblingPath: bytes(NULLIFIER_PATH_BYTES + 1) },
      }),
    ).rejects.toThrow(`nullifierMembershipWitness.siblingPath has ${NULLIFIER_PATH_BYTES + 1} bytes`);
  });
});

// `jsonStringify` encodes every Buffer as base64, so the base64 branch is the one real clients use — and the one an
// attacker gets for free. A sibling path carries its own element count, which the deserializer walks before anything
// compares it to the tree height, so both the encoded length and the count are pinned before decoding.
describe('attacker-controlled witness buffers', () => {
  const b64 = (buf: Buffer) => buf.toString('base64');
  const vector = (count: number, entries: number) => {
    const buf = Buffer.alloc(VECTOR_COUNT_BYTES + entries * Fr.SIZE_IN_BYTES);
    buf.writeUInt32BE(count, 0);
    return buf;
  };

  it('rejects a sibling path declaring more entries than the tree height', async () => {
    // 153 bytes on the wire; upstream would allocate 2**32 - 1 entries from these four.
    await expect(
      WithdrawalFinalizationInputSchema.parseAsync({
        signerApprovalWitness: { siblingPath: b64(vector(0xffffffff, 0)) },
      }),
    ).rejects.toThrow(`publicDataWitness.siblingPath must be exactly ${PUBLIC_DATA_PATH_BYTES} bytes`);

    // Right length, lying count.
    await expect(
      FrozenDepositRefundFinalizationInputSchema.parseAsync({
        lowNullifierMembershipWitness: { siblingPath: b64(vector(0xffffffff, NULLIFIER_TREE_HEIGHT)) },
      }),
    ).rejects.toThrow(`nullifierMembershipWitness.siblingPath must declare exactly ${NULLIFIER_TREE_HEIGHT} entries`);
  });

  it('rejects an undersized sibling path with a schema error', async () => {
    for (const siblingPath of ['', b64(Buffer.alloc(2))]) {
      await expect(
        WithdrawalFinalizationInputSchema.parseAsync({ signerApprovalWitness: { siblingPath } }),
      ).rejects.toThrow(`publicDataWitness.siblingPath must be exactly ${PUBLIC_DATA_PATH_BYTES} bytes`);
    }
  });

  it('rejects an over-length base64 witness instead of decoding and truncating it', async () => {
    const overlong = b64(Buffer.alloc(ARCHIVE_BYTES + 4 * 1024 * 1024));
    await expect(
      WithdrawalFinalizationInputSchema.parseAsync({ hints: { archiveMembershipWitness: overlong } }),
    ).rejects.toThrow(`archiveMembershipWitness is ${overlong.length} base64 chars`);

    // Just past the cap, so it survives the pre-decode bound and has to be caught on the decoded length.
    await expect(
      WithdrawalFinalizationInputSchema.parseAsync({
        hints: { archiveMembershipWitness: b64(Buffer.alloc(ARCHIVE_BYTES + 1)) },
      }),
    ).rejects.toThrow(`archiveMembershipWitness must be exactly ${ARCHIVE_BYTES} bytes`);
  });

  it('still accepts witnesses encoded the way the client sends them', async () => {
    const roundTrip = (value: unknown) => JSON.parse(jsonStringify(value));

    await expect(
      archiveMembershipWitnessSchema.parseAsync(roundTrip(MembershipWitness.random(ARCHIVE_HEIGHT))),
    ).resolves.toBeInstanceOf(MembershipWitness);
    await expect(publicDataWitnessSchema.parseAsync(roundTrip(PublicDataWitness.random()))).resolves.toBeInstanceOf(
      PublicDataWitness,
    );
    await expect(
      nullifierMembershipWitnessSchema.parseAsync(roundTrip(NullifierMembershipWitness.random())),
    ).resolves.toBeInstanceOf(NullifierMembershipWitness);
  });
});

// Addresses reach the enclave as a hex string or as a byte array. Both encodings are capped on size, and the encoding a
// real client sends still round-trips.
describe('attacker-controlled addresses', () => {
  it('caps address byte arrays before validating bytes', async () => {
    const over = ADDRESS_BYTES + 1;
    await expect(
      TokenOperationSchema.parseAsync({
        spentNotes: [],
        createdNotes: [{ owner: { type: 'Buffer', data: new Array(over).fill(-1) } }],
        deposits: [],
        withdrawals: [],
      }),
    ).rejects.toThrow(`note.owner has ${over} bytes, exceeds max ${ADDRESS_BYTES}`);

    await expect(
      FrozenDepositRefundFinalizationInputSchema.parseAsync({
        l2Recipient: { type: 'Buffer', data: new Array(1024 * 1024).fill(-1) },
      }),
    ).rejects.toThrow(`l2Recipient has ${1024 * 1024} bytes, exceeds max ${ADDRESS_BYTES}`);
  });

  it('caps an over-length address string before matching it', async () => {
    const overlong = `0x${'f'.repeat(4 * 1024 * 1024)}`;
    await expect(FrozenDepositRefundFinalizationInputSchema.parseAsync({ l2Recipient: overlong })).rejects.toThrow(
      `l2Recipient is ${overlong.length} hex chars, exceeds max ${ADDRESS_HEX_CHARS}`,
    );
  });

  it('still accepts addresses encoded the way the client sends them', async () => {
    const note = { amount: 1n, owner: await AztecAddress.random(), randomness: Fr.random() };
    await expect(NoteDataSchema.parseAsync(JSON.parse(jsonStringify(note)))).resolves.toEqual(note);
  });
});

describe('u128 amounts and tips', () => {
  const withdrawal = (fields: Partial<Record<'amount' | 'proverTip', bigint>>) => ({
    executor: EthAddress.fromField(new Fr(1)),
    userPayloadHash: Fr.ZERO,
    amount: 0n,
    proverTip: 0n,
    randomness: Fr.ZERO,
    ...fields,
  });

  it('rejects a negative amount', async () => {
    await expect(OutboxWithdrawalSchema.parseAsync(withdrawal({ amount: -1n }))).rejects.toThrow(/Too small/);
  });

  it('rejects a tip of 2^128', async () => {
    await expect(OutboxWithdrawalSchema.parseAsync(withdrawal({ proverTip: 2n ** 128n }))).rejects.toThrow(/Too big/);
  });

  it('accepts the u128 maximum encoded the way the client sends it', async () => {
    const max = withdrawal({ amount: 2n ** 128n - 1n });
    await expect(OutboxWithdrawalSchema.parseAsync(JSON.parse(jsonStringify(max)))).resolves.toEqual(max);
  });
});

// The passkey and the WebAuthn assertion are byte buffers. `jsonStringify` sends them as base64, every buffer is capped
// on size, and the encoding a real client sends still round-trips. The fallback-key mode of the authorization carries
// a point and four field halves instead.
describe('attacker-controlled authorization material', () => {
  const b64 = (buf: Buffer) => buf.toString('base64');

  it('caps the assertion buffers before decoding them', async () => {
    const overlong = b64(Buffer.alloc(WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN + 4 * 1024 * 1024));
    await expect(
      FrozenDepositRefundFinalizationInputSchema.parseAsync({
        auth: { kind: 'passkey', webauthn: { clientDataJSON: overlong } },
      }),
    ).rejects.toThrow(`auth.webauthn.clientDataJSON is ${overlong.length} base64 chars`);

    await expect(
      FrozenDepositRefundFinalizationInputSchema.parseAsync({
        auth: {
          kind: 'passkey',
          webauthn: { clientDataJSON: b64(Buffer.alloc(WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN + 1)) },
        },
      }),
    ).rejects.toThrow(`auth.webauthn.clientDataJSON must be at most ${WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN} bytes`);

    await expect(
      FrozenNotesRefundFinalizationInputSchema.parseAsync({
        auth: {
          kind: 'passkey',
          webauthn: { authenticatorData: b64(Buffer.alloc(WEBAUTHN_AUTHENTICATOR_DATA_LEN + 1)) },
        },
      }),
    ).rejects.toThrow(`auth.webauthn.authenticatorData must be exactly ${WEBAUTHN_AUTHENTICATOR_DATA_LEN} bytes`);

    await expect(
      FrozenDepositRefundFinalizationInputSchema.parseAsync({
        auth: { kind: 'passkey', passkey: { x: b64(Buffer.alloc(33)) } },
      }),
    ).rejects.toThrow('auth.passkey.x must be exactly 32 bytes');
  });

  it('still accepts passkey material encoded the way the client sends them', async () => {
    const auth = {
      kind: 'passkey',
      passkey: { x: Buffer.alloc(32, 1), y: Buffer.alloc(32, 2) },
      webauthn: {
        authenticatorData: Buffer.alloc(WEBAUTHN_AUTHENTICATOR_DATA_LEN, 3),
        clientDataJSON: Buffer.from('{"type":"webauthn.get","challenge":"x"}', 'utf8'),
        signature: Buffer.alloc(64, 4),
      },
    };
    const result = await FrozenDepositRefundFinalizationInputSchema.safeParseAsync(JSON.parse(jsonStringify({ auth })));
    // Every other field is missing, so the parse fails; the authorization fields must not be among the issues.
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map(issue => String(issue.path[0]));
    expect(paths).not.toContain('auth');
  });

  it('still accepts a fallback-key authorization encoded the way the client sends it', async () => {
    const auth = {
      kind: 'fallbackKey',
      fbpkM: await Point.random(),
      signature: { sLo: new Fr(1), sHi: new Fr(2), eLo: new Fr(3), eHi: new Fr(4) },
    };
    const result = await UnprocessedDepositRefundFinalizationInputSchema.safeParseAsync(
      JSON.parse(jsonStringify({ auth })),
    );
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map(issue => String(issue.path[0]));
    expect(paths).not.toContain('auth');
  });
});
