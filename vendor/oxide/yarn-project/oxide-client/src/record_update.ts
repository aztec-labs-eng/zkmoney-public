import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  CANONICAL_ENTRY_POINT_V08,
  type Call,
  EntryPointAbi,
  ErrorsAbi,
  NamePortalAbi,
  type PackedUserOperation,
  type R1PublicKeyArg,
  type UserRecordArg,
  type WebAuthnAuthArg,
  buildUserOp,
  encodeExecuteBatch,
  encodeR1UserOpSignature,
  encodeSetUserRecord,
  getAccountNonce,
  getAuthKeys,
  getUserOpHash,
  readAccountMetadataRegistry,
  readMetadataStateHash,
  readRegistrationController,
  userRecordStateHash,
} from '@oxide/l1-contracts';
import { type BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import {
  type Address,
  BaseError,
  type Hex,
  type Log,
  type PublicClient,
  decodeErrorResult,
  encodeFunctionData,
  hexToBigInt,
  hexToBytes,
  isAddressEqual,
  parseEventLogs,
  slice,
} from 'viem';

/**
 * How a metadata registry writes a record: the registry call that the account makes, and the `metadataStateHash` that
 * the registration controller reports after it. A registry of a new schema has its own write.
 */
export interface RecordWrite {
  data: Hex;
  stateHash: Hex;
}

/** A record update that the account's passkey signs: one zero-fee user operation that writes the record and notifies L2. */
export interface RecordUpdate {
  owner: Address;
  nameRegistry: Address;
  metadataRegistry: Address;
  namePortal: Address;
  /** The L2 recipient of the name notification. */
  namePortalRecipient: Hex;
  rollupVersion: bigint;
  record: UserRecordArg;
  write: RecordWrite;
  /** The index of the signing passkey in the account's auth keys. */
  keyIndex: bigint;
  /** The unsigned user operation, on nonce key 0. */
  userOp: PackedUserOperation;
  /** The hash of `userOp` that the canonical EntryPoint computes. The passkey signs it. */
  userOpHash: Hex;
}

/** What the chain shows about a record update now. A reorg can change it. */
export type RecordUpdateResult =
  /** No execution of the operation is in the logs that the reader read. `nonceUsed`: another operation took its nonce. */
  | { status: 'not-run'; nonceUsed: boolean }
  /** The account call failed. The nonce is used. `revertReason` is `0x` when the EntryPoint reports none. */
  | { status: 'failed'; txHash: Hex; revertReason: Hex }
  /** The record was written and L2 notified. `recordHeld`: the controller's state hash is still the update's. */
  | { status: 'succeeded'; txHash: Hex; notification: { key: Hex; index: bigint }; recordHeld: boolean };

/**
 * A record update of `owner` for the migration to `rollupVersion`: one user operation writes `record` to the current
 * metadata registry and notifies `namePortalRecipient` through the name portal. Its fees are zero and it has no
 * paymaster, so the account pays nothing. The relayer gets no payout.
 *
 * - There is no on-chain check that the record did not change since the build, so a pending update can overwrite a
 *   newer record. Send one record update for each account at a time, and serialize every user operation of the account
 *   on nonce key 0, passkey rotations included.
 * - `namePortalRecipient` must be the ClaimFPC of the destination: the gate of its registered rail consumes the
 *   notification. The builder cannot check that.
 * - `write` defaults to `setUserRecord`. A registry of another schema needs its own `write`; its address alone does
 *   not show the schema.
 *
 * Throws when `metadataRegistry` is not the current registry of the name registry, when the record and the
 * notification name different rollup versions, when a recipient is zero, or when the account does not hold `passkey`.
 */
export async function buildRecordUpdate(
  publicClient: PublicClient,
  args: {
    owner: Address;
    metadataRegistry: Address;
    namePortal: Address;
    namePortalRecipient: AztecAddress;
    rollupVersion: bigint;
    record: UserRecordArg;
    write?: RecordWrite;
    /** The public key of the passkey that signs. */
    passkey: R1PublicKeyArg;
  },
): Promise<RecordUpdate> {
  const { owner, metadataRegistry, namePortal, rollupVersion, record } = args;
  if (record.rollupVersion !== rollupVersion) {
    throw new Error(
      `The record names rollup version ${record.rollupVersion}, but the notification names ${rollupVersion}`,
    );
  }
  if (args.namePortalRecipient.isZero() || BigInt(record.l2Address) === 0n) {
    throw new Error('A record update needs a notification recipient and a record L2 address that are not zero');
  }
  const nameRegistry = await publicClient.readContract({
    address: namePortal,
    abi: NamePortalAbi,
    functionName: 'NAME_REGISTRY',
  });
  const [currentRegistry, authKeys, nonce] = await Promise.all([
    readAccountMetadataRegistry(publicClient, nameRegistry),
    getAuthKeys(publicClient, owner),
    getAccountNonce(publicClient, CANONICAL_ENTRY_POINT_V08, owner),
  ]);
  if (!isAddressEqual(currentRegistry, metadataRegistry)) {
    throw new Error(`The current metadata registry is ${currentRegistry}, not ${metadataRegistry}`);
  }
  const keyIndex = authKeys.findIndex(({ key }) => sameKey(key, args.passkey));
  if (keyIndex < 0) {
    throw new Error(`The account ${owner} has no passkey ${args.passkey.qx}`);
  }
  const namePortalRecipient = args.namePortalRecipient.toString() as Hex;
  const write = args.write ?? {
    data: encodeSetUserRecord(owner, record),
    stateHash: userRecordStateHash(record),
  };
  const userOp = buildUserOp({
    sender: owner,
    nonce,
    callData: encodeExecuteBatch(
      recordUpdateCalls({
        owner,
        metadataRegistry,
        writeData: write.data,
        namePortal,
        namePortalRecipient,
        rollupVersion,
      }),
    ),
    gas: {
      verificationGasLimit: USER_OP_VERIFICATION_GAS,
      callGasLimit: RECORD_UPDATE_CALL_GAS,
      preVerificationGas: 0n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    },
  });
  return {
    owner,
    nameRegistry,
    metadataRegistry,
    namePortal,
    namePortalRecipient,
    rollupVersion,
    record,
    write,
    keyIndex: BigInt(keyIndex),
    userOp,
    userOpHash: await getUserOpHash(publicClient, CANONICAL_ENTRY_POINT_V08, userOp),
  };
}

/**
 * The L1 operation that runs a signed record update, for a broadcast with an immediate condition. It pays no payout.
 * `target` is the contract that the relayer calls: the canonical EntryPoint, or later a subsidy that calls it.
 *
 * It simulates the update first and throws when it would fail: the account call, with the gas that the signed
 * operation gives it, and the signed `handleOps`, which checks the signature and the nonce. The chain can still change
 * before the relay, so check the result with `readRecordUpdateResult`.
 */
export async function buildRecordUpdateOperation(
  publicClient: PublicClient,
  update: RecordUpdate,
  assertion: WebAuthnAuthArg,
  args: { target: Address; payoutToken: Address },
): Promise<BroadcastL1Operation> {
  const { owner, userOp } = update;
  // The low 16 bytes of `accountGasLimits` hold the call gas limit.
  const callGasLimit = hexToBigInt(slice(userOp.accountGasLimits, 16));
  await simulate(
    'account call',
    publicClient.call({
      account: CANONICAL_ENTRY_POINT_V08,
      to: owner,
      data: userOp.callData,
      gas: callGasLimit + intrinsicGas(userOp.callData),
    }),
  );
  const calldata = encodeFunctionData({
    abi: EntryPointAbi,
    functionName: 'handleOps',
    args: [[{ ...userOp, signature: encodeR1UserOpSignature(update.keyIndex, assertion) }], owner],
  });
  await simulate('signed operation', publicClient.call({ to: CANONICAL_ENTRY_POINT_V08, data: calldata }));
  return {
    target: EthAddress.fromString(args.target),
    payoutToken: EthAddress.fromString(args.payoutToken),
    calldata: Buffer.from(calldata.slice(2), 'hex'),
    condition: L1OperationCondition.immediate(),
  };
}

/**
 * Reads what the chain shows about `update`, from `logs` (for example a receipt's) or from the logs since `fromBlock`.
 * The EntryPoint reports an account call that fails without a revert of the relayer's transaction, and the nonce is
 * used anyway. Stop on `failed`, and start the refunds only after `succeeded` with `recordHeld`.
 */
export async function readRecordUpdateResult(
  publicClient: PublicClient,
  update: RecordUpdate,
  from: { logs: readonly Log[] } | { fromBlock: bigint },
): Promise<RecordUpdateResult> {
  const logs = 'logs' in from ? from.logs : await logsOfExecution(publicClient, update, from.fromBlock);
  const unique = [...new Map(logs.filter(log => !log.removed).map(log => [logKey(log), log])).values()];
  const executions = parseEventLogs({
    abi: EntryPointAbi,
    eventName: 'UserOperationEvent',
    args: { userOpHash: update.userOpHash },
    logs: unique,
  }).filter(log => isAddressEqual(log.address, CANONICAL_ENTRY_POINT_V08));
  if (executions.length === 0) {
    const nonce = await getAccountNonce(publicClient, CANONICAL_ENTRY_POINT_V08, update.owner);
    return { status: 'not-run', nonceUsed: nonce > update.userOp.nonce };
  }
  if (executions.length > 1) {
    throw new Error(`The logs hold ${executions.length} executions of user operation ${update.userOpHash}`);
  }
  const [{ transactionHash: txHash, args: execution }] = executions;
  const inTx = unique.filter(log => log.transactionHash === txHash);
  if (!execution.success) {
    const reason = parseEventLogs({
      abi: EntryPointAbi,
      eventName: 'UserOperationRevertReason',
      args: { userOpHash: update.userOpHash },
      logs: inTx,
    }).find(log => isAddressEqual(log.address, CANONICAL_ENTRY_POINT_V08));
    return { status: 'failed', txHash, revertReason: reason?.args.revertReason ?? '0x' };
  }
  const notifications = parseEventLogs({ abi: NamePortalAbi, eventName: 'NameNotified', logs: inTx }).filter(
    ({ address, args }) =>
      isAddressEqual(address, update.namePortal) &&
      isAddressEqual(args.user, update.owner) &&
      BigInt(args.l2Recipient) === BigInt(update.namePortalRecipient) &&
      args.rollupVersion === update.rollupVersion,
  );
  if (notifications.length !== 1) {
    throw new Error(`Transaction ${txHash} holds ${notifications.length} matching name notifications, not one`);
  }
  const [{ args: notified }] = notifications;
  const controller = await readRegistrationController(publicClient, update.nameRegistry);
  const stateHash = await readMetadataStateHash(publicClient, controller, update.owner);
  return {
    status: 'succeeded',
    txHash,
    notification: { key: notified.key, index: notified.index },
    recordHeld: stateHash.toLowerCase() === update.write.stateHash.toLowerCase(),
  };
}

/** The calls of a user operation that writes the owner's record and then notifies L2 through the name portal. */
export function recordUpdateCalls(args: {
  owner: Address;
  metadataRegistry: Address;
  writeData: Hex;
  namePortal: Address;
  namePortalRecipient: Hex;
  rollupVersion: bigint;
}): Call[] {
  return [
    { target: args.metadataRegistry, value: 0n, data: args.writeData },
    {
      target: args.namePortal,
      value: 0n,
      data: encodeFunctionData({
        abi: NamePortalAbi,
        functionName: 'notify',
        args: [args.owner, args.namePortalRecipient, args.rollupVersion],
      }),
    },
  ];
}

/** The receipt logs of the transaction that executed `update`, or none when no transaction since `fromBlock` did. */
async function logsOfExecution(publicClient: PublicClient, update: RecordUpdate, fromBlock: bigint): Promise<Log[]> {
  const [execution] = await publicClient.getContractEvents({
    address: CANONICAL_ENTRY_POINT_V08,
    abi: EntryPointAbi,
    eventName: 'UserOperationEvent',
    args: { userOpHash: update.userOpHash },
    fromBlock,
  });
  if (!execution) {
    return [];
  }
  return (await publicClient.getTransactionReceipt({ hash: execution.transactionHash })).logs;
}

/** Awaits a simulation call, and throws with the decoded error when it reverts. */
async function simulate(label: string, call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (err) {
    const data = err instanceof BaseError ? revertData(err) : undefined;
    throw new Error(`The record update's ${label} reverts: ${data ? decodeRevert(data) : String(err)}`, {
      cause: err,
    });
  }
}

function revertData(err: BaseError): Hex | undefined {
  const found = err.walk(e => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null;
  return found?.data;
}

function decodeRevert(data: Hex): string {
  try {
    const { errorName, args } = decodeErrorResult({ abi: [...EntryPointAbi, ...ErrorsAbi], data });
    return `${errorName}(${(args ?? []).map(String).join(', ')})`;
  } catch {
    return data;
  }
}

/** The intrinsic gas of a call with `data`: the base cost and the calldata cost. */
function intrinsicGas(data: Hex): bigint {
  const bytes = hexToBytes(data);
  const zeros = bytes.filter(b => b === 0).length;
  return 21_000n + 4n * BigInt(zeros) + 16n * BigInt(bytes.length - zeros);
}

function logKey(log: Log): string {
  return `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
}

function sameKey(a: R1PublicKeyArg, b: R1PublicKeyArg): boolean {
  return BigInt(a.qx) === BigInt(b.qx) && BigInt(a.qy) === BigInt(b.qy);
}

/**
 * The verification gas limit of a passkey user operation. A WebAuthn signature check used 27k in a test with the
 * P-256 precompile, and 268k in Solidity without it. The limit is about 1.5 times the larger.
 */
export const USER_OP_VERIFICATION_GAS = 400_000n;

/**
 * The call gas limit of a record update. In a test, an overwrite of the record and `notify` used 129k, and a first
 * write into a registry with one more field and `notify` used 240k. The limit is 2.5 times the larger. A higher limit
 * costs the account nothing at zero fees, but a lower one makes the account call fail and uses the nonce.
 */
export const RECORD_UPDATE_CALL_GAS = 600_000n;
