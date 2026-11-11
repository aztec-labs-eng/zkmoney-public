import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';

import {
  type AuthKeyEntry,
  CANONICAL_ENTRY_POINT_V08,
  type UserRecordArg,
  computeSIPAAddress,
  packU128LimbsToBytes32,
} from '@oxide/l1-contracts';

import { describe, expect, it, jest } from '@jest/globals';
import type { Address, Hex, PublicClient } from 'viem';

import {
  MAX_ADD_PASSKEY_CALL_GAS,
  buildAddPasskeySipa,
  buildAddPasskeyUserOp,
  findPasskey,
  passkeyMetadata,
} from './add_passkey.js';
import { SIMULATED_SENDER_BALANCE } from './l1_operation_quote.js';
import { USER_OP_VERIFICATION_GAS } from './record_update.js';

const OWNER: Address = '0x00000000000000000000000000000000000000aa';
const CREDENTIAL_B: Hex = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const CREDENTIAL_C: Hex = '0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const WALLET_KEY_B: Hex = '0x0b0b0b';
const WALLET_KEY_C: Hex = '0x0c0c0c0c';
const CREDENTIAL_D: Hex = '0xd1d1d1d1';
const SIPA_FACTORY: Address = '0x00000000000000000000000000000000000000f1';
const IMPLEMENTATION: Address = '0x00000000000000000000000000000000000000f2';
const NAME_PORTAL: Address = '0x00000000000000000000000000000000000000f5';
const METADATA_REGISTRY: Address = '0x00000000000000000000000000000000000000f6';
const GAS_ESTIMATE = 300_000n;
// The intrinsic gas of the account call of `buildFixedAddition`.
const INTRINSIC_GAS = 27_644n;
// The SIPA and the user operation hash of `buildFixedAddition`.
const SIPA: Address = '0x817ca47c3c8Cc7E803c9F5bE4fE9A84b3660c7e6';
const USER_OP_HASH: Hex = '0x5b42c103c2db842b59a118afd6f3c9e9c8a9952086fc84b743e85c6f9220e21d';

const AUTH_KEYS: AuthKeyEntry[] = [
  { key: { qx: '0x01', qy: '0x02' }, metadata: '0x' },
  { key: { qx: '0x03', qy: '0x04' }, metadata: passkeyMetadata(CREDENTIAL_B, WALLET_KEY_B) },
  { key: { qx: '0x05', qy: '0x06' }, metadata: passkeyMetadata(CREDENTIAL_C, WALLET_KEY_C) },
  { key: { qx: '0x07', qy: '0x08' }, metadata: passkeyMetadata(CREDENTIAL_D, '0x') },
];

const publicClient = {
  chain: { id: 31337 },
  readContract: ({ address, functionName }: { address: Address; functionName: string }) => {
    if (address !== OWNER || functionName !== 'getAuthKeys') {
      throw new Error(`unexpected read of ${functionName} on ${address}`);
    }
    return Promise.resolve(AUTH_KEYS);
  },
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

describe('buildAddPasskeySipa', () => {
  const args = {
    sipaFactory: OWNER,
    implementation: OWNER,
    forwardingTable: OWNER,
    metadataRegistry: OWNER,
    namePortal: OWNER,
    rollupVersion: 1n,
    owner: OWNER,
    record: { rollupVersion: 1n } as UserRecordArg,
    recipient: AztecAddress.fromBigIntUnsafe(1n),
    add: { passkey: AUTH_KEYS[1].key, credentialId: CREDENTIAL_B, encryptedWalletKey: WALLET_KEY_B },
  };

  it('rejects a record of another rollup version', async () => {
    await expect(
      buildAddPasskeySipa(publicClient, { ...args, record: { rollupVersion: 2n } as UserRecordArg }),
    ).rejects.toThrow('The record names rollup version 2, but the passkey addition names 1');
  });

  it('rejects a zero recipient', async () => {
    await expect(buildAddPasskeySipa(publicClient, { ...args, recipient: AztecAddress.ZERO })).rejects.toThrow(
      'A passkey addition needs a recipient that is not zero',
    );
  });

  it('computes the SIPA address and the user operation hash of the passkey addition', async () => {
    const { sipa, userOpHash } = await buildFixedAddition(factoryClient());

    expect(sipa).toBe(SIPA);
    expect(userOpHash).toBe(USER_OP_HASH);
  });

  it('rejects a SIPA that the factory does not predict', async () => {
    const other: Address = '0x00000000000000000000000000000000000000e1';
    await expect(buildFixedAddition(factoryClient(() => Promise.resolve(other)))).rejects.toThrow(
      `The SIPA factory ${SIPA_FACTORY} predicts ${other}, not the SIPA ${SIPA}`,
    );
  });

  it('rejects a name portal that the SIPA implementation does not notify', async () => {
    const other: Address = '0x00000000000000000000000000000000000000e2';
    await expect(buildFixedAddition(factoryClient(), { namePortal: other })).rejects.toThrow(
      `The AddPasskey SIPA ${IMPLEMENTATION} notifies the name portal ${NAME_PORTAL}, not ${other}`,
    );
  });

  it('rejects a metadata registry that is not the current one', async () => {
    const other: Address = '0x00000000000000000000000000000000000000e3';
    await expect(buildFixedAddition(factoryClient(), { metadataRegistry: other })).rejects.toThrow(
      `The current metadata registry is ${METADATA_REGISTRY}, not ${other}`,
    );
  });

  it('rejects a factory that does not answer', async () => {
    await expect(
      buildFixedAddition(factoryClient(() => Promise.reject(new Error('execution reverted')))),
    ).rejects.toThrow(`The SIPA factory ${SIPA_FACTORY} did not confirm the SIPA ${SIPA}`);
  });

  it('signs 3/2 of the gas estimate of the account call, less its intrinsic gas, as the call gas', async () => {
    const estimateGas = jest.fn((_request: unknown) => Promise.resolve(GAS_ESTIMATE));
    const { intent } = await buildFixedAddition(factoryClient(undefined, estimateGas));

    expect(intent.accountGasLimits).toBe(packU128LimbsToBytes32(USER_OP_VERIFICATION_GAS, 408_534n));
    expect(estimateGas).toHaveBeenCalledWith({
      account: CANONICAL_ENTRY_POINT_V08,
      to: OWNER,
      data: buildAddPasskeyUserOp(intent, { metadataRegistry: METADATA_REGISTRY, namePortal: NAME_PORTAL }).callData,
      stateOverride: [{ address: CANONICAL_ENTRY_POINT_V08, balance: SIMULATED_SENDER_BALANCE }],
    });
  });

  it('signs a call gas at the limit', async () => {
    const { intent } = await buildFixedAddition(
      factoryClient(predictFromArgs, () => Promise.resolve(2_666_667n + INTRINSIC_GAS)),
    );

    expect(intent.accountGasLimits).toBe(packU128LimbsToBytes32(USER_OP_VERIFICATION_GAS, MAX_ADD_PASSKEY_CALL_GAS));
  });

  it('rejects a call gas above the limit', async () => {
    await expect(
      buildFixedAddition(factoryClient(predictFromArgs, () => Promise.resolve(2_666_668n + INTRINSIC_GAS))),
    ).rejects.toThrow('The passkey addition needs 4000002 call gas, more than 4000000');
  });

  it('rejects an addition whose account call fails in a gas estimate', async () => {
    const reverted = new Error('execution reverted');
    const error = await buildFixedAddition(factoryClient(undefined, () => Promise.reject(reverted))).catch(
      (err: unknown) => err,
    );

    expect(error).toEqual(new Error('The passkey addition fails in a gas estimate'));
    expect((error as Error).cause).toBe(reverted);
  });

  it('checks the SIPA targets before the gas estimate', async () => {
    const other: Address = '0x00000000000000000000000000000000000000e2';
    const client = factoryClient(undefined, () => Promise.reject(new Error('execution reverted')));
    await expect(buildFixedAddition(client, { namePortal: other })).rejects.toThrow(
      `The AddPasskey SIPA ${IMPLEMENTATION} notifies the name portal ${NAME_PORTAL}, not ${other}`,
    );
  });

  it('rejects a client without a configured chain', async () => {
    await expect(buildAddPasskeySipa({ ...publicClient, chain: undefined } as PublicClient, args)).rejects.toThrow(
      'The public client needs a configured chain',
    );
  });
});

type ContractRead = { address: Address; functionName: string; args?: readonly unknown[] };

/**
 * A client of a chain that holds the SIPA implementation, whose SIPA factory answers with `predictSIPA`, and whose gas
 * estimates answer with `estimateGas`.
 */
function factoryClient(
  predictSIPA: (read: ContractRead) => Promise<unknown> = () => Promise.resolve(SIPA),
  estimateGas: (request: unknown) => Promise<bigint> = () => Promise.resolve(GAS_ESTIMATE),
): PublicClient {
  const reads: Record<string, (read: ContractRead) => Promise<unknown>> = {
    getNonce: () => Promise.resolve(3n),
    NAME_REGISTRY: () => Promise.resolve('0x00000000000000000000000000000000000000f4'),
    NAME_PORTAL: () => Promise.resolve(NAME_PORTAL),
    accountMetadataRegistry: () => Promise.resolve(METADATA_REGISTRY),
    predictSIPA,
  };
  return {
    chain: { id: 31337 },
    readContract: (read: ContractRead) => reads[read.functionName](read),
    estimateGas,
  } as unknown as PublicClient;
}

/** A factory that predicts the SIPA of its arguments, as the deployed factory does. */
function predictFromArgs({ address, args }: ContractRead): Promise<Address> {
  const [implementation, intentHash, recoveryCommitment, rollupVersion, resweepable, forwardingTable] = args as [
    Address,
    Hex,
    Hex,
    bigint,
    boolean,
    Address,
  ];
  return Promise.resolve(
    computeSIPAAddress(address, {
      implementation,
      intentHash,
      recoveryCommitment,
      rollupVersion,
      resweepable,
      forwardingTable,
    }),
  );
}

/** A passkey addition with fixed inputs. The shared secret salt is random, so a fixed one pins the SIPA. */
async function buildFixedAddition(
  publicClient: PublicClient,
  overrides: Partial<Parameters<typeof buildAddPasskeySipa>[1]> = {},
) {
  jest.spyOn(Fr, 'random').mockReturnValue(new Fr(5n));
  try {
    return await buildAddPasskeySipa(publicClient, {
      sipaFactory: SIPA_FACTORY,
      implementation: IMPLEMENTATION,
      forwardingTable: '0x00000000000000000000000000000000000000f3',
      metadataRegistry: METADATA_REGISTRY,
      namePortal: NAME_PORTAL,
      rollupVersion: 1n,
      owner: OWNER,
      record: {
        l2Address: `0x${'12'.repeat(32)}`,
        rollupVersion: 1n,
        publicKey: { x: 1n, y: 2n },
        resolverOperator: '0x00000000000000000000000000000000000000ff',
      },
      recipient: AztecAddress.fromBigIntUnsafe(1n),
      add: {
        passkey: { qx: `0x${'03'.repeat(32)}`, qy: `0x${'04'.repeat(32)}` },
        credentialId: CREDENTIAL_B,
        encryptedWalletKey: WALLET_KEY_B,
      },
      ...overrides,
    });
  } finally {
    jest.restoreAllMocks();
  }
}
