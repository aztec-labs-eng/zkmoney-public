import { AztecAddress } from '@aztec-labs/aztec.js/addresses';

import type { AuthKeyEntry, R1PublicKeyArg, UserRecordArg } from '@oxide/l1-contracts';

import { describe, expect, it } from '@jest/globals';
import type { Address, Hex, PublicClient } from 'viem';

import { buildRotationIntent, findPasskey, passkeyMetadata } from './passkey_rotation.js';

const OWNER: Address = '0x00000000000000000000000000000000000000aa';
const CREDENTIAL_B: Hex = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const CREDENTIAL_C: Hex = '0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const WALLET_KEY_B: Hex = '0x0b0b0b';
const WALLET_KEY_C: Hex = '0x0c0c0c0c';
const CREDENTIAL_D: Hex = '0xd1d1d1d1';

const AUTH_KEYS: AuthKeyEntry[] = [
  { key: { qx: '0x01', qy: '0x02' }, metadata: '0x' },
  { key: { qx: '0x03', qy: '0x04' }, metadata: passkeyMetadata(CREDENTIAL_B, WALLET_KEY_B) },
  { key: { qx: '0x05', qy: '0x06' }, metadata: passkeyMetadata(CREDENTIAL_C, WALLET_KEY_C) },
  { key: { qx: '0x07', qy: '0x08' }, metadata: passkeyMetadata(CREDENTIAL_D, '0x') },
];

const publicClient = {
  readContract: ({ address, functionName }: { address: Address; functionName: string }) => {
    if (functionName === 'getNonce') {
      return Promise.resolve(0n);
    }
    if (address !== OWNER || functionName !== 'getAuthKeys') {
      throw new Error(`unexpected read of ${functionName} on ${address}`);
    }
    return Promise.resolve(AUTH_KEYS);
  },
  call: () => Promise.resolve({ data: '0x01' }),
} as unknown as PublicClient;

describe('findPasskey', () => {
  it('finds the auth key that names the credential ID', async () => {
    expect(await findPasskey(publicClient, OWNER, CREDENTIAL_C)).toEqual({
      index: 2n,
      passkey: AUTH_KEYS[2].key,
      encryptedWalletKey: WALLET_KEY_C,
    });
  });

  it('finds an auth key with an empty encrypted wallet key', async () => {
    expect(await findPasskey(publicClient, OWNER, CREDENTIAL_D)).toEqual({
      index: 3n,
      passkey: AUTH_KEYS[3].key,
      encryptedWalletKey: '0x',
    });
  });

  it('returns undefined for a credential ID that no auth key names', async () => {
    expect(await findPasskey(publicClient, OWNER, '0xe1e1e1e1')).toBeUndefined();
  });
});

describe('buildRotationIntent', () => {
  const rotate = (add: R1PublicKeyArg[], remove: R1PublicKeyArg[]) =>
    buildRotationIntent(publicClient, {
      sipaFactory: OWNER,
      implementation: OWNER,
      forwardingTable: OWNER,
      metadataRegistry: OWNER,
      namePortal: OWNER,
      rollupVersion: 1n,
      owner: OWNER,
      record: {} as UserRecordArg,
      recipient: AztecAddress.fromBigIntUnsafe(1n),
      add: add.map(passkey => ({ passkey, credentialId: CREDENTIAL_B, encryptedWalletKey: WALLET_KEY_B })),
      remove,
    });

  it('rejects a passkey that it adds and removes', async () => {
    await expect(rotate([AUTH_KEYS[1].key], [AUTH_KEYS[1].key])).rejects.toThrow('changes passkey 0x03 twice');
  });

  it('rejects a rotation that removes every passkey', async () => {
    await expect(
      rotate(
        [],
        AUTH_KEYS.map(({ key }) => key),
      ),
    ).rejects.toThrow('at least one passkey');
  });

  it('rejects a removal of a passkey that the account does not have', async () => {
    await expect(rotate([], [{ qx: '0x09', qy: '0x0a' }])).rejects.toThrow('has no passkey 0x09');
  });
});
