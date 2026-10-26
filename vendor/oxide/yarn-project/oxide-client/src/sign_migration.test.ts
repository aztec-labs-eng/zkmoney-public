import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { jsonParseWithSchema, jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { PublicKeys, deriveKeys } from '@aztec-labs/stdlib/keys';

import {
  type PasskeyPublicKey,
  type PasskeySigner,
  type WebAuthnAuth,
  computeAccountAddress,
  computePasskeyHash,
  computePasskeySetImmutablesHash,
  computePasskeySetSlots,
  passkeySetSlots,
} from '@oxide/oxide-lib/account_address.js';
import {
  type MigrationSignature,
  type PasskeyMigrationSignature,
  type PasskeyMigrationSigner,
  type RefundOwner,
  assertValidMigrationSignature,
  computeRefundCommitment,
} from '@oxide/oxide-lib/migration_signature.js';
import { MigrationSignatureSchema } from '@oxide/oxide-lib/types.js';

import { describe, expect, it } from '@jest/globals';

import { PermanentError } from './errors.js';
import { assertRefundOwner, signMigration } from './sign_migration.js';

// The two forms of one P-256 signature: `s_low + s_high` is the curve order, and only `s_low` is at most half of it.
const R = 'cc373c505a3e689a64d0548f0766e6f5f368d1570fe03819d818b9eeb077531a';
const S_LOW = '61e59a8c9c0c7e38cbee296f44df3be18dec796c3c0123edc9d1ee8992f003d9';
const S_HIGH = '9e1a657263f381c83411d690bb20c41e2efa81416b167a9729e7dc3969732178';

const LOW_S_SIGNATURE = Buffer.from(R + S_LOW, 'hex');
const HIGH_S_SIGNATURE = Buffer.from(R + S_HIGH, 'hex');

const PASSKEY: PasskeyPublicKey = { x: Buffer.alloc(32, 1), y: Buffer.alloc(32, 2) };
const EXECUTOR = EthAddress.fromField(new Fr(0xe5ec));
const USER_PAYLOAD_HASH = new Fr(0x9a71);

/**
 * A signer that always returns the same assertion and records the challenges it signs. `signMigration` verifies nothing,
 * so only `signature` has to be realistic.
 */
function fakeSigner(signature: Buffer): PasskeySigner & { challenges: Fr[] } {
  const challenges: Fr[] = [];
  return {
    publicKey: PASSKEY,
    challenges,
    sign: (challenge: Fr): Promise<WebAuthnAuth> => {
      challenges.push(challenge);
      return Promise.resolve({
        authenticatorData: Buffer.alloc(37, 3),
        clientDataJSON: Buffer.from('{"type":"webauthn.get"}', 'utf8'),
        signature,
      });
    },
  };
}

describe('signMigration', () => {
  it('normalises a high-s signature from the authenticator', async () => {
    const signature = await signMigration({
      signer: await onePasskeySigner(fakeSigner(HIGH_S_SIGNATURE)),
      executor: EXECUTOR,
      userPayloadHash: USER_PAYLOAD_HASH,
    });
    expect(passkeyMode(signature).webauthn.signature).toEqual(LOW_S_SIGNATURE);
  });

  it('leaves a low-s signature unchanged', async () => {
    const signature = await signMigration({
      signer: await onePasskeySigner(fakeSigner(LOW_S_SIGNATURE)),
      executor: EXECUTOR,
      userPayloadHash: USER_PAYLOAD_HASH,
    });
    expect(passkeyMode(signature).webauthn.signature).toEqual(LOW_S_SIGNATURE);
  });

  it('rejects a malformed signature permanently', async () => {
    const signer = await onePasskeySigner(fakeSigner(Buffer.alloc(32)));
    await expect(signMigration({ signer, executor: EXECUTOR, userPayloadHash: USER_PAYLOAD_HASH })).rejects.toThrow(
      PermanentError,
    );
  });

  it('carries the passkey set of the account', async () => {
    const passkeyHash = await computePasskeyHash(PASSKEY);
    const passkeySet = passkeySetSlots([new Fr(9), passkeyHash]);
    const signature = await signMigration({
      signer: { kind: 'passkey', passkeySigner: fakeSigner(LOW_S_SIGNATURE), passkeySet },
      executor: EXECUTOR,
      userPayloadHash: USER_PAYLOAD_HASH,
    });
    expect(passkeyMode(signature).passkeySet).toEqual(passkeySet);
  });

  it('signs a migration with the fallback key that verifies for its user payload hash and no other', async () => {
    const { masterFallbackSecretKey, publicKeys } = await deriveKeys(Fr.random());
    const instance = {
      contractClassId: new Fr(1),
      salt: new Fr(2),
      initializationHash: new Fr(3),
      deployer: AztecAddress.ZERO,
    };
    const owner = await computeAccountAddress(publicKeys, instance, Fr.ZERO);
    const signature = await signMigration({
      signer: { kind: 'fallbackKey', fbskM: masterFallbackSecretKey },
      executor: EXECUTOR,
      userPayloadHash: USER_PAYLOAD_HASH,
    });
    const assertValid = (userPayloadHash: Fr) =>
      assertValidMigrationSignature(owner, publicKeys, instance, EXECUTOR, userPayloadHash, signature);

    await expect(assertValid(USER_PAYLOAD_HASH)).resolves.toBeUndefined();
    await expect(assertValid(USER_PAYLOAD_HASH.add(Fr.ONE))).rejects.toThrow('invalid fallback-key signature');
  });

  it('asks the passkey once, over the refund commitment', async () => {
    const passkeySigner = fakeSigner(HIGH_S_SIGNATURE);
    const signer = { kind: 'passkey' as const, passkeySigner, passkeySet: await computePasskeySetSlots([PASSKEY]) };
    const signature = passkeyMode(
      await signMigration({ signer, executor: EXECUTOR, userPayloadHash: USER_PAYLOAD_HASH }),
    );

    expect(passkeySigner.challenges).toEqual([await computeRefundCommitment(EXECUTOR, USER_PAYLOAD_HASH)]);
    expect(signature.webauthn.signature).toEqual(LOW_S_SIGNATURE);
  });

  it('restores a signature that a wallet saved as JSON', async () => {
    const signer = await onePasskeySigner(fakeSigner(LOW_S_SIGNATURE));
    const signature = await signMigration({ signer, executor: EXECUTOR, userPayloadHash: USER_PAYLOAD_HASH });

    expect(jsonParseWithSchema(jsonStringify(signature), MigrationSignatureSchema)).toEqual(signature);
  });
});

describe('assertRefundOwner', () => {
  it('accepts an owner whose signer is in its passkey set', async () => {
    const passkeyHash = await computePasskeyHash(PASSKEY);
    const owner = await passkeyOwner(passkeySetSlots([new Fr(9), passkeyHash]));

    await expect(assertRefundOwner(owner)).resolves.toBeUndefined();
  });

  it('rejects a signer outside the passkey set permanently', async () => {
    const owner = await passkeyOwner(passkeySetSlots([new Fr(9), new Fr(10)]));

    await expect(assertRefundOwner(owner)).rejects.toThrow(PermanentError);
  });
});

async function onePasskeySigner(passkeySigner: PasskeySigner): Promise<PasskeyMigrationSigner> {
  return { kind: 'passkey', passkeySigner, passkeySet: await computePasskeySetSlots([passkeySigner.publicKey]) };
}

function passkeyMode(signature: MigrationSignature): PasskeyMigrationSignature {
  if (signature.kind !== 'passkey') {
    throw new Error('Expected a passkey signature');
  }
  return signature;
}

async function passkeyOwner(passkeySet: Fr[]): Promise<RefundOwner> {
  const publicKeys = PublicKeys.default();
  const instance = {
    contractClassId: new Fr(1),
    salt: new Fr(2),
    initializationHash: new Fr(3),
    deployer: AztecAddress.ZERO,
  };
  const immutablesHash = await computePasskeySetImmutablesHash(passkeySet);
  const address = await computeAccountAddress(publicKeys, instance, immutablesHash);
  return {
    address,
    publicKeys,
    instance,
    signer: { kind: 'passkey', passkeySigner: fakeSigner(LOW_S_SIGNATURE), passkeySet },
  };
}
