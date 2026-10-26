import { AztecAddress } from '@aztec-labs/aztec.js/addresses';

import {
  type AuthKeyEntry,
  CANONICAL_ENTRY_POINT_V08,
  EntryPointAbi,
  NamePortalAbi,
  type PackedUserOperation,
  type UserRecordArg,
  userRecordStateHash,
} from '@oxide/l1-contracts';
import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it } from '@jest/globals';
import {
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
} from 'viem';

import { buildRecordUpdate, buildRecordUpdateOperation, readRecordUpdateResult } from './record_update.js';

const OWNER: Address = '0x00000000000000000000000000000000000000aa';
const NAME_REGISTRY: Address = '0x00000000000000000000000000000000000000bb';
const METADATA_REGISTRY: Address = '0x00000000000000000000000000000000000000cc';
const NAME_PORTAL: Address = '0x00000000000000000000000000000000000000dd';
const CONTROLLER: Address = '0x00000000000000000000000000000000000000ee';
const CLAIM_FPC = AztecAddress.fromBigIntUnsafe(0xf9cn);
const ROLLUP_VERSION = 6n;
const NONCE = 7n;
const USER_OP_HASH: Hex = `0x${'a1'.repeat(32)}`;
const TX: Hex = `0x${'7e'.repeat(32)}`;
const RECORD: UserRecordArg = {
  l2Address: `0x${'12'.repeat(32)}`,
  rollupVersion: ROLLUP_VERSION,
  publicKey: { x: 1n, y: 2n },
  resolverOperator: '0x00000000000000000000000000000000000000ff',
};
// The original passkey has empty metadata. A later one carries its credential ID.
const AUTH_KEYS: AuthKeyEntry[] = [
  { key: { qx: '0x03', qy: '0x04' }, metadata: '0x0102' },
  { key: { qx: '0x01', qy: '0x02' }, metadata: '0x' },
];
const ASSERTION = {
  r: `0x${'7a'.repeat(32)}`,
  s: `0x${'7a'.repeat(32)}`,
  challengeIndex: 23n,
  typeIndex: 1n,
  authenticatorData: '0x05',
  clientDataJSON: '{}',
} as const;

/** A client of a chain that holds the account, its registries and the EntryPoint. */
function chain({ nonce = NONCE, stateHash = userRecordStateHash(RECORD), reverts = false } = {}) {
  const hashed: PackedUserOperation[] = [];
  const reads: Record<string, (address: Address, args: readonly unknown[]) => unknown> = {
    NAME_REGISTRY: () => NAME_REGISTRY,
    accountMetadataRegistry: () => METADATA_REGISTRY,
    registrationController: () => CONTROLLER,
    metadataStateHash: () => stateHash,
    getAuthKeys: () => AUTH_KEYS,
    getNonce: () => nonce,
    getUserOpHash: (address, [op]) => {
      if (address !== CANONICAL_ENTRY_POINT_V08) {
        throw new Error(`getUserOpHash on ${address}`);
      }
      hashed.push(op as PackedUserOperation);
      return USER_OP_HASH;
    },
  };
  const publicClient = {
    readContract: ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) =>
      Promise.resolve(reads[functionName](address, args ?? [])),
    call: () => (reverts ? Promise.reject(new Error('execution reverted')) : Promise.resolve({ data: '0x' })),
  } as unknown as PublicClient;
  return { publicClient, hashed };
}

const build = (publicClient: PublicClient, overrides: Partial<Parameters<typeof buildRecordUpdate>[1]> = {}) =>
  buildRecordUpdate(publicClient, {
    owner: OWNER,
    metadataRegistry: METADATA_REGISTRY,
    namePortal: NAME_PORTAL,
    namePortalRecipient: CLAIM_FPC,
    rollupVersion: ROLLUP_VERSION,
    record: RECORD,
    passkey: { qx: '0x01', qy: '0x02' },
    ...overrides,
  });

describe('buildRecordUpdate', () => {
  it('builds a zero-fee user operation that writes the record and then notifies, signed over the EntryPoint hash', async () => {
    const { publicClient, hashed } = chain();
    const update = await build(publicClient);

    expect(update.keyIndex).toBe(1n);
    expect(update.userOp).toEqual({
      sender: OWNER,
      nonce: NONCE,
      initCode: '0x',
      callData: GOLDEN_CALL_DATA,
      accountGasLimits: GOLDEN_GAS_LIMITS,
      preVerificationGas: 0n,
      gasFees: `0x${'00'.repeat(32)}`,
      paymasterAndData: '0x',
      signature: '0x',
    });
    expect(hashed).toEqual([update.userOp]);
    expect(update.userOpHash).toBe(USER_OP_HASH);
  });

  it('writes with the write of another schema', async () => {
    const write = { data: '0xabcdef' as Hex, stateHash: `0x${'5a'.repeat(32)}` as Hex };
    const update = await build(chain().publicClient, { write });

    expect(update.write).toEqual(write);
    expect(update.userOp.callData).toContain('abcdef');
    expect(update.userOp.callData).not.toBe(GOLDEN_CALL_DATA);
  });

  it('refuses another registry, another rollup version and a passkey that the account does not hold', async () => {
    const { publicClient } = chain();
    await expect(build(publicClient, { metadataRegistry: OWNER })).rejects.toThrow('current metadata registry');
    await expect(build(publicClient, { rollupVersion: 5n })).rejects.toThrow('rollup version');
    await expect(build(publicClient, { passkey: { qx: '0x09', qy: '0x09' } })).rejects.toThrow('has no passkey');
  });
});

describe('buildRecordUpdateOperation', () => {
  it('targets the relay target at once, and refuses an update whose simulation reverts', async () => {
    const update = await build(chain().publicClient);
    const target: Address = '0x0000000000000000000000000000000000000abc';
    const payoutToken: Address = '0x0000000000000000000000000000000000000dad';

    const operation = await buildRecordUpdateOperation(chain().publicClient, update, ASSERTION, {
      target,
      payoutToken,
    });
    expect(operation.target.toString()).toBe(target);
    expect(operation.payoutToken.toString()).toBe(payoutToken);
    expect(operation.condition.kind).toBe(L1OperationConditionKind.Immediate);

    await expect(
      buildRecordUpdateOperation(chain({ reverts: true }).publicClient, update, ASSERTION, { target, payoutToken }),
    ).rejects.toThrow("record update's account call reverts");
  });
});

describe('readRecordUpdateResult', () => {
  const executed = (success: boolean) =>
    eventLog(CANONICAL_ENTRY_POINT_V08, EntryPointAbi, 'UserOperationEvent', {
      userOpHash: USER_OP_HASH,
      sender: OWNER,
      paymaster: '0x0000000000000000000000000000000000000000',
      nonce: NONCE,
      success,
      actualGasCost: 0n,
      actualGasUsed: 100_000n,
    });
  const notified = (l2Recipient: Hex) =>
    eventLog(NAME_PORTAL, NamePortalAbi, 'NameNotified', {
      user: OWNER,
      nameHash: `0x${'4e'.repeat(32)}`,
      l2Recipient,
      rollupVersion: ROLLUP_VERSION,
      key: `0x${'6b'.repeat(32)}`,
      index: 9n,
    });

  it('reports an update that has not run, and whether its nonce is used', async () => {
    const update = await build(chain().publicClient);

    expect(await readRecordUpdateResult(chain().publicClient, update, { logs: [] })).toEqual({
      status: 'not-run',
      nonceUsed: false,
    });
    expect(await readRecordUpdateResult(chain({ nonce: NONCE + 1n }).publicClient, update, { logs: [] })).toEqual({
      status: 'not-run',
      nonceUsed: true,
    });
  });

  it('reports a failed account call with its revert reason', async () => {
    const update = await build(chain().publicClient);
    const reason = eventLog(CANONICAL_ENTRY_POINT_V08, EntryPointAbi, 'UserOperationRevertReason', {
      userOpHash: USER_OP_HASH,
      sender: OWNER,
      nonce: NONCE,
      revertReason: '0x1234',
    });

    expect(await readRecordUpdateResult(chain().publicClient, update, { logs: [executed(false), reason] })).toEqual({
      status: 'failed',
      txHash: TX,
      revertReason: '0x1234',
    });
    expect(await readRecordUpdateResult(chain().publicClient, update, { logs: [executed(false)] })).toEqual({
      status: 'failed',
      txHash: TX,
      revertReason: '0x',
    });
  });

  it("reports a success with the update's notification and whether the record still holds", async () => {
    const update = await build(chain().publicClient);
    // A notification to another recipient is not the update's, and a log read twice counts once.
    const logs = [notified(`0x${'99'.repeat(32)}`), notified(update.namePortalRecipient), executed(true)];
    const expected = {
      status: 'succeeded',
      txHash: TX,
      notification: { key: `0x${'6b'.repeat(32)}`, index: 9n },
    };

    expect(await readRecordUpdateResult(chain().publicClient, update, { logs: [...logs, logs[1]] })).toEqual({
      ...expected,
      recordHeld: true,
    });
    const overwritten = chain({ stateHash: `0x${'00'.repeat(32)}` }).publicClient;
    expect(await readRecordUpdateResult(overwritten, update, { logs })).toEqual({ ...expected, recordHeld: false });
  });
});

let logIndex = 0;

/** A log of `eventName` from `address` in the transaction `TX`. */
function eventLog(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>): Log {
  const event = getAbiItem({ abi, name: eventName }) as AbiEvent;
  const data = event.inputs.filter(input => !input.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args } as never) as Log['topics'],
    data: encodeAbiParameters(
      data,
      data.map(input => args[input.name!]),
    ),
    blockHash: `0x${'b0'.repeat(32)}`,
    blockNumber: 1n,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
  };
}

// `execute(batch, [setUserRecord(OWNER, RECORD) on METADATA_REGISTRY, notify(OWNER, CLAIM_FPC, 6) on NAME_PORTAL])`.
const GOLDEN_CALL_DATA: Hex =
  '0xe9ae5c530100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002e000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000000cc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c4208e5f5c00000000000000000000000000000000000000000000000000000000000000aa121212121212121212121212121212121212121212121212121212121212121200000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000ff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000dd000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000064fa1b04e500000000000000000000000000000000000000000000000000000000000000aa0000000000000000000000000000000000000000000000000000000000000f9c000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000';
// 400,000 verification gas and 600,000 call gas.
const GOLDEN_GAS_LIMITS: Hex = '0x00000000000000000000000000061a80000000000000000000000000000927c0';
