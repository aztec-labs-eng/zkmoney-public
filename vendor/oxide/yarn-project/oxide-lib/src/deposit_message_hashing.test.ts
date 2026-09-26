// Cross-implementation parity test for the deposit message derivation: content hash, message hash, and siloed
// nullifier. Computes each value on the TS side and pins it into the Noir `#[test]` body in
// `oxide_token_lib/src/deposit_message_hashing.nr`, guarding the recipient-commitment secretHash slot and the
// nhk_app-keyed nullifier derivation shared by every consumer.
//
// Regenerate after touching either implementation:
//   OXIDE_GENERATE_TEST_DATA=1 yarn workspace @oxide/oxide-lib test deposit_message_hashing
//
// Then `cd noir-projects/oxide_token_lib && aztec-nargo test` to verify the Noir side matches.
import { Fr } from '@aztec/foundation/curves/bn254';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';

import { describe, expect, it } from '@jest/globals';

import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
  getDepositMessageContentHash,
} from './deposit_message_hashing.js';
import { updateInlineTestData } from './testing/files.js';

const NOIR_TEST_FILE = 'noir-projects/oxide_token_lib/src/deposit_message_hashing.nr';

// Arbitrary-but-fixed fixtures. Must match the `let fixture_*` values in the Noir #[test].
const FIXTURE_SHARED_SECRET_SALT = Fr.fromHexString(
  '0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
);
const FIXTURE_L2_RECIPIENT = AztecAddress.fromFieldUnsafe(
  Fr.fromHexString('0x0ead00000000000000000000000000000000000000000000000000000000bee0'),
);
const FIXTURE_AMOUNT = 1234567890n;
const FIXTURE_L1_PORTAL = EthAddress.fromString('0x1122334455667788990011223344556677889900');
const FIXTURE_CHAIN_ID = 31337n;
const FIXTURE_L2_TOKEN = AztecAddress.fromFieldUnsafe(
  Fr.fromHexString('0x0abc00000000000000000000000000000000000000000000000000000000cba0'),
);
const FIXTURE_ROLLUP_VERSION = 42n;
const FIXTURE_LEAF_INDEX = new Fr(1025n);
// Must match the `fixture_nhk_m_hi`/`fixture_nhk_m_lo` limbs in the Noir #[test].
const FIXTURE_NHK_M = GrumpkinScalar.fromHexString(
  '0x2222333344445555666677778888999900001111bbbbccccddddeeeeffff0000',
);

describe('deposit_message_hashing TS ↔ Noir parity', () => {
  it('pins the content hash, message hash, and nullifier for the Noir #[test]', async () => {
    const contentHash = getDepositMessageContentHash(FIXTURE_AMOUNT);

    const portal = {
      l1Portal: FIXTURE_L1_PORTAL,
      l1ChainId: FIXTURE_CHAIN_ID,
      l2Portal: FIXTURE_L2_TOKEN,
      rollupVersion: FIXTURE_ROLLUP_VERSION,
    };
    const messageHash = await computeDepositMessageHash(portal, {
      sharedSecretSalt: FIXTURE_SHARED_SECRET_SALT,
      recipient: FIXTURE_L2_RECIPIENT,
      amount: FIXTURE_AMOUNT,
      messageLeafIndex: FIXTURE_LEAF_INDEX,
    });
    // The TS mirror pins the siloed form (what the kernel emits and the refund circuits check).
    const siloedNullifier = await computeSiloedDepositMessageNullifier(FIXTURE_L2_TOKEN, messageHash, FIXTURE_NHK_M);

    // If any of the hashes change for a valid reason, update the inline snapshot and rerun the test
    // with `OXIDE_GENERATE_TEST_DATA=1` to regenerate the expected values on the noir side.
    expect(contentHash.toString()).toMatchInlineSnapshot(
      `"0x009fd9a30be1e999ee89f99ec76efc2f9f2fb16399e29943592aa4b5749ed86f"`,
    );
    expect(messageHash.toString()).toMatchInlineSnapshot(
      `"0x004ff64030f3a064714344a22bf5a0bd6acb03c969360639faa227371a5d0d13"`,
    );
    expect(siloedNullifier.toString()).toMatchInlineSnapshot(
      `"0x23a8c6f45f5e5245c1872d348426816fdaa80b72c906daf4db7d97d86bc9be30"`,
    );

    updateInlineTestData(NOIR_TEST_FILE, 'expected_deposit_message_content_hash', contentHash.toString());
    updateInlineTestData(NOIR_TEST_FILE, 'expected_deposit_message_hash', messageHash.toString());
    updateInlineTestData(NOIR_TEST_FILE, 'expected_deposit_message_nullifier', siloedNullifier.toString());
  });
});
