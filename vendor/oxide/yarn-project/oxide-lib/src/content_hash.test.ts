// Cross-implementation parity test for the recipient commitment and the withdraw content hash. Computes each hash on the
// TS side and pins the expected values into the Noir `#[test]` bodies in `oxide_token_lib/src/content_hash.nr`.
// The Noir tests assert the same input → same output, so the implementations drift only when this test is re-run
// with `OXIDE_GENERATE_TEST_DATA=1`.
//
// Regenerate after touching either implementation:
//   OXIDE_GENERATE_TEST_DATA=1 yarn workspace @oxide/oxide-lib test content_hash
//
// Then `cd noir-projects/oxide_token_lib && aztec-nargo test` to verify the Noir side matches.
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';

import { describe, expect, it } from '@jest/globals';

import { getUserPayloadHash, getWithdrawContentHash } from './content_hash.js';
import { computeRecipientCommitment } from './recipient_commitment.js';
import { updateInlineTestData } from './testing/files.js';

const NOIR_TEST_FILE = 'noir-projects/oxide_token_lib/src/content_hash.nr';

// Arbitrary-but-fixed fixtures. Must match the `let fixture_*` values in the Noir #[test]s.
const FIXTURE_SHARED_SECRET_SALT = Fr.fromHexString(
  '0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
);
const FIXTURE_L2_RECIPIENT = AztecAddress.fromFieldUnsafe(
  Fr.fromHexString('0x0ead00000000000000000000000000000000000000000000000000000000bee0'),
);
const FIXTURE_AMOUNT = 1234567890n;
const FIXTURE_PROVER_TIP = 75317531n;
const FIXTURE_RANDOMNESS = Fr.fromHexString('0x2222333344445555666677778888999900001111aaaabbbbccccddddeeeeffff');
const FIXTURE_EXECUTOR = EthAddress.fromString('0x11223344556677889900aabbccddeeff00112233');
const FIXTURE_USER_PAYLOAD = Buffer.from('deadbeef', 'hex');
const FIXTURE_PLAIN_WITHDRAWAL_PAYLOAD = Buffer.from(
  '00000000000000000000000011223344556677889900aabbccddeeff0011223300000000000000000000000000000000000000000000000000000000047d411b',
  'hex',
);
const FIXTURE_PLAIN_WITHDRAWAL_PAYLOAD_HASH = '0x00ce6a41ff263e87fd9e2bb589e3708df5b40098af39741e2a6f92cedc4610b6';

describe('content_hash TS ↔ Noir parity', () => {
  it('pins expected hashes for the Noir #[test]', async () => {
    const recipientCommitment = await computeRecipientCommitment(FIXTURE_SHARED_SECRET_SALT, FIXTURE_L2_RECIPIENT);
    const userPayloadHash = getUserPayloadHash(FIXTURE_USER_PAYLOAD);
    const withdraw = getWithdrawContentHash(
      FIXTURE_EXECUTOR,
      userPayloadHash,
      FIXTURE_AMOUNT,
      FIXTURE_PROVER_TIP,
      FIXTURE_RANDOMNESS,
    );

    // If any of the hashes change for a valid reason, update the inline snapshot and rerun the test
    // with `OXIDE_GENERATE_TEST_DATA=1` to regenerate the expected values on the noir side.
    expect(recipientCommitment.toString()).toMatchInlineSnapshot(
      `"0x2edfa85ed3d7333e199dbdf8be5c2b4887fc556a9cc1ba5fb19ac8386d4a6ee8"`,
    );
    expect(withdraw.toString()).toMatchInlineSnapshot(
      `"0x0040e5e411ba5f4a9730607ebac66817a44df07a56cfc8df8a42d497e9bb5e9b"`,
    );

    updateInlineTestData(NOIR_TEST_FILE, 'expected_recipient_commitment', recipientCommitment.toString());
    updateInlineTestData(NOIR_TEST_FILE, 'fixture_user_payload_hash', userPayloadHash.toString());
    updateInlineTestData(NOIR_TEST_FILE, 'expected_withdraw_content_hash', withdraw.toString());
  });

  it('commits the executor and user payload hash', () => {
    const userPayloadHash = getUserPayloadHash(FIXTURE_USER_PAYLOAD);
    const contentHash = getWithdrawContentHash(
      FIXTURE_EXECUTOR,
      userPayloadHash,
      FIXTURE_AMOUNT,
      FIXTURE_PROVER_TIP,
      FIXTURE_RANDOMNESS,
    );

    expect(contentHash.toString()).toMatchInlineSnapshot(
      `"0x0040e5e411ba5f4a9730607ebac66817a44df07a56cfc8df8a42d497e9bb5e9b"`,
    );
    expect(getUserPayloadHash(Buffer.from('deadbeee', 'hex')).equals(userPayloadHash)).toBe(false);
    expect(
      getWithdrawContentHash(
        FIXTURE_EXECUTOR,
        userPayloadHash,
        FIXTURE_AMOUNT,
        FIXTURE_PROVER_TIP + 1n,
        FIXTURE_RANDOMNESS,
      ).equals(contentHash),
    ).toBe(false);
  });

  it('hashes the canonical plain withdrawal payload', () => {
    expect(getUserPayloadHash(FIXTURE_PLAIN_WITHDRAWAL_PAYLOAD).toString()).toBe(FIXTURE_PLAIN_WITHDRAWAL_PAYLOAD_HASH);
  });

  it('rejects withdrawal values outside the L2 u128 range', () => {
    const userPayloadHash = getUserPayloadHash(Buffer.alloc(0));
    const hash = (amount: bigint, proverTip: bigint) =>
      getWithdrawContentHash(FIXTURE_EXECUTOR, userPayloadHash, amount, proverTip, FIXTURE_RANDOMNESS);

    expect(() => hash(-1n, 0n)).toThrow(/amount must fit in u128/);
    expect(() => hash(1n << 128n, 0n)).toThrow(/amount must fit in u128/);
    expect(() => hash(0n, -1n)).toThrow(/proverTip must fit in u128/);
    expect(() => hash(0n, 1n << 128n)).toThrow(/proverTip must fit in u128/);
  });
});
