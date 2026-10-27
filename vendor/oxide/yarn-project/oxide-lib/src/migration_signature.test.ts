import { Fr } from '@aztec-labs/aztec.js/fields';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { PublicKeys } from '@aztec-labs/stdlib/keys';

import { describe, expect, it } from '@jest/globals';

import {
  type AccountInstancePreimage,
  computeAccountAddress,
  computePasskeyHash,
  computePasskeySetImmutablesHash,
  computePasskeySetSlots,
  passkeySetSlots,
  verifyWebAuthnAuth,
} from './account_address.js';
import {
  type PasskeyMigrationSignature,
  assertValidMigrationSignature,
  computeRefundCommitment,
} from './migration_signature.js';
import {
  TEST_EXECUTOR,
  TEST_REFUND_COMMITMENT,
  TEST_USER_PAYLOAD_HASH,
  TEST_WEBAUTHN,
} from './testing/migration_vector.js';
import { TEST_PASSKEY } from './testing/webauthn_vector.js';

describe('the pinned migration', () => {
  it('matches the pinned refund commitment', async () => {
    expect(await computeRefundCommitment(TEST_EXECUTOR, TEST_USER_PAYLOAD_HASH)).toEqual(TEST_REFUND_COMMITMENT);
  });

  it('verifies the pinned assertion over the refund commitment', async () => {
    expect(await verifyWebAuthnAuth(TEST_PASSKEY, TEST_REFUND_COMMITMENT, TEST_WEBAUTHN)).toBe(true);
  });
});

const OTHER_PASSKEY_HASH = new Fr(9);

const INSTANCE: AccountInstancePreimage = {
  contractClassId: new Fr(0x1234),
  salt: new Fr(0x5678),
  initializationHash: new Fr(0x9abc),
  deployer: AztecAddress.ZERO,
};

describe('assertValidMigrationSignature with a passkey set', () => {
  const assertValid = (
    owner: AztecAddress,
    publicKeys: PublicKeys,
    passkeySet: Fr[],
    userPayloadHash = TEST_USER_PAYLOAD_HASH,
  ) =>
    assertValidMigrationSignature(owner, publicKeys, INSTANCE, TEST_EXECUTOR, userPayloadHash, signature(passkeySet));

  it('accepts a passkey of the owner set', async () => {
    const { publicKeys, owner, slots } = await setOwner();
    await expect(assertValid(owner, publicKeys, slots)).resolves.toBeUndefined();
  });

  it('rejects another user payload hash', async () => {
    const { publicKeys, owner, slots } = await setOwner();
    await expect(assertValid(owner, publicKeys, slots, TEST_USER_PAYLOAD_HASH.add(Fr.ONE))).rejects.toThrow(
      'invalid WebAuthn signature',
    );
  });

  it('rejects a passkey outside the owner set', async () => {
    const publicKeys = PublicKeys.default();
    const slots = passkeySetSlots([OTHER_PASSKEY_HASH]);
    const immutablesHash = await computePasskeySetImmutablesHash(slots);
    const owner = await computeAccountAddress(publicKeys, INSTANCE, immutablesHash);
    await expect(assertValid(owner, publicKeys, slots)).rejects.toThrow("passkey is not in the owner's passkey set");
  });

  it('rejects a passkey set the owner does not commit to', async () => {
    const { publicKeys, owner } = await setOwner();
    const onePasskeySet = await computePasskeySetSlots([TEST_PASSKEY]);
    await expect(assertValid(owner, publicKeys, onePasskeySet)).rejects.toThrow(
      'migration signature does not match owner address',
    );
  });
});

async function setOwner() {
  const publicKeys = PublicKeys.default();
  const passkeyHash = await computePasskeyHash(TEST_PASSKEY);
  const slots = passkeySetSlots([OTHER_PASSKEY_HASH, passkeyHash]);
  const immutablesHash = await computePasskeySetImmutablesHash(slots);
  const owner = await computeAccountAddress(publicKeys, INSTANCE, immutablesHash);
  return { publicKeys, owner, slots };
}

function signature(passkeySet: Fr[]): PasskeyMigrationSignature {
  return {
    kind: 'passkey',
    passkey: TEST_PASSKEY,
    passkeySet,
    webauthn: TEST_WEBAUTHN,
  };
}
