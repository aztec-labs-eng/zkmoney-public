/**
 * Adding a backup passkey is one user operation the root passkey signs: install the key, point the
 * record at the two-key address, notify the name portal. An add-passkey SIPA builds and runs it when
 * the relayer sweeps the SIPA, so the wallet prepares and signs it ahead of time, keeps it, checks
 * the account against it before funding anything, and builds the sweep that runs it.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { p256 } from "@noble/curves/p256"
import { sha256 } from "@noble/hashes/sha2"
import { L1_SETTLED_DEPTH, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  AccountMetadataRegistryAbi,
  CANONICAL_ENTRY_POINT_V08,
  EntryPointAbi,
  OxideAccountAbi,
  SIPAFactoryAbi,
  SipaIntent as OxideSipaIntent,
  computeUserOpHash,
  encodeAddAuthKey,
  encodeAddPasskeyIntentData,
  getAuthKeys,
  getUserRecord,
  hasUserRecord,
  readBlessedIntent,
  readSIPAImplementation,
  type AddPasskeyIntent,
  type AuthKeyEntry,
  type R1PublicKeyArg,
  type SipaDeployArgs,
  type UserRecordArg,
} from "@oxide/l1-contracts"
import {
  MAX_ADD_PASSKEY_CALL_GAS,
  buildAddPasskeySipa,
  buildAddPasskeySweep,
  buildAddPasskeyUserOp,
  passkeyMetadata,
  type AddPasskeySipa,
} from "@oxide/oxide-client/add_passkey.js"
import { readPlainWithdrawalFee } from "@oxide/oxide-client/executors/plain_withdrawal_executor.js"
import { USER_OP_VERIFICATION_GAS, configuredChainId } from "@oxide/oxide-client/record_update.js"
import {
  L1OperationCondition,
  type BroadcastL1Operation,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import { assertPlainWithdrawalTip } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import { computeSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  concatHex,
  decodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  numberToBytes,
  parseAbiParameters,
  size,
  slice,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { RevertingSweepError, UnprofitableSweepError } from "../oxide/tip/l1OperationQuote.js"
import {
  assertSubsidySweepsSipa,
  readSweepRouteLiveness,
  readAddPasskeySIPAImplementation,
  SupersededImplementationError,
} from "./sipa/sipaIntents.js"

/** An add-passkey SIPA with the intent, the deploy args and the hash the root key signs. */
export type RotationIntent = AddPasskeySipa

/** The deployment a rotation runs on. A `MetadataDestination` satisfies it. */
export interface BackupRotationTuple {
  rollupVersion: bigint
  metadataRegistry: Address
  factory: Address
  forwardingTable: Address
  namePortal: Address
  portal: Address
  /** The fee token: the portal's underlying, which the SIPA is funded and swept in. */
  token: Address
  depositSubsidy: Address
  operationExecutor: Address
}

/** The backup passkey a rotation installs. */
export interface BackupPasskeyAdd {
  pubkey: R1PublicKeyArg
  /** The raw credential id. */
  credentialId: Hex
  /** The wallet key sealed under the passkey; the key's metadata carries it, then the credential id. */
  envelope: Hex
}

/** The longest credential id a backup may carry: the longest oxide's add-passkey tests run. */
export const MAX_BACKUP_CREDENTIAL_ID_BYTES = 128
/** WebAuthn's floor, which the on-chain reader also holds the appended id to. */
const MIN_BACKUP_CREDENTIAL_ID_BYTES = 16

/** The credential id is outside the length a backup key can carry. */
export class BackupCredentialIdLengthError extends Error {
  constructor(readonly bytes: number) {
    super(
      `The credential id is ${bytes} bytes; a backup key carries ` +
        `${MIN_BACKUP_CREDENTIAL_ID_BYTES}..${MAX_BACKUP_CREDENTIAL_ID_BYTES}`,
    )
    this.name = "BackupCredentialIdLengthError"
  }
}

/**
 * The bytes the installed key's metadata carries behind oxide's prefix: the envelope, then the raw
 * credential id, so a sign-in can name a passkey the browser cannot list. Refuses an id outside
 * the backup length.
 */
export function backupKeyPayload(add: BackupPasskeyAdd): Hex {
  const bytes = size(add.credentialId)
  if (bytes < MIN_BACKUP_CREDENTIAL_ID_BYTES || bytes > MAX_BACKUP_CREDENTIAL_ID_BYTES) {
    throw new BackupCredentialIdLengthError(bytes)
  }
  return concatHex([add.envelope, add.credentialId])
}

/** The record the account must hold for a rotation to be prepared. */
export interface ExpectedRecord {
  l2Address: Hex
  rollupVersion: bigint
}

export interface PrepareBackupRotationArgs {
  tuple: BackupRotationTuple
  owner: Address
  /** The one key the account must list. */
  rootKey: R1PublicKeyArg
  recordExpected: ExpectedRecord
  add: BackupPasskeyAdd
  /** The two-key address the record is pointed at. */
  recipient: AztecAddress
}

export interface PreparedBackupRotation {
  rotation: RotationIntent
  /** The key set the intent was built against: the root key alone, with its metadata. */
  expectedKeys: AuthKeyEntry[]
  /** The add-passkey implementation the SIPA clones: the factory's at prepare time. */
  implementation: Address
  /** The factory `implementation` was read from. */
  sipaFactory: Address
  /** The record the intent was built over; the operation rewrites only its address. */
  builtOver: UserRecordArg
  add: BackupPasskeyAdd
}

/** The account's keys, nonce or record moved since the rotation was prepared. */
export class BackupSetConflictError extends Error {
  constructor(
    reason: string,
    readonly expected: readonly R1PublicKeyArg[],
    readonly live: readonly AuthKeyEntry[],
  ) {
    super(`The account changed since the rotation was prepared: ${reason}`)
    this.name = "BackupSetConflictError"
  }
}

/** The account lists no passkey at all; a rotation needs the root key to sign. */
export class RootKeyNotInstalledError extends Error {
  constructor(readonly owner: Address) {
    super(`Account ${owner} has no passkey installed`)
    this.name = "RootKeyNotInstalledError"
  }
}

/** The registry's record is missing or names another address or rollup version. */
export class AccountRecordMismatchError extends Error {
  constructor(readonly expected: ExpectedRecord, readonly live: UserRecordArg | undefined) {
    super(
      live
        ? `The account's record names ${live.l2Address} at rollup version ${live.rollupVersion}, ` +
            `not ${expected.l2Address} at ${expected.rollupVersion}`
        : "The account has no record in the registry",
    )
    this.name = "AccountRecordMismatchError"
  }
}

/** The forwarding table or the deposit subsidy would not sweep an add-passkey SIPA of the token. */
export class RotationRouteNotLiveError extends Error {
  constructor(readonly reason: string) {
    super(`The rotation's sweep route is not live: ${reason}`)
    this.name = "RotationRouteNotLiveError"
  }
}

/**
 * Whether `err` is the chain refusing a backup rotation's sweep as it stands, not a read that did
 * not complete: the wallet parks the attempt on the first and retries the second.
 */
export const backupSweepRefused = (err: unknown): boolean =>
  err instanceof RotationRouteNotLiveError ||
  err instanceof SupersededImplementationError ||
  err instanceof RevertingSweepError ||
  err instanceof UnprofitableSweepError

/** A read the structural check needs did not complete. Not a mismatch: the record is unjudged. */
export class VerificationUnavailableError extends Error {
  constructor(readonly step: string, cause: unknown) {
    super(`Could not read ${step}`, { cause })
    this.name = "VerificationUnavailableError"
  }
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const sameWord = (a: Hex, b: Hex) => BigInt(a) === BigInt(b)
const sameKey = (a: R1PublicKeyArg, b: R1PublicKeyArg) =>
  sameWord(a.qx, b.qx) && sameWord(a.qy, b.qy)
const sameEntry = (a: AuthKeyEntry, b: AuthKeyEntry) =>
  sameKey(a.key, b.key) && sameHex(a.metadata, b.metadata)
const sameKeySet = (a: readonly AuthKeyEntry[], b: readonly AuthKeyEntry[]) =>
  a.length === b.length && a.every((entry, i) => sameEntry(entry, b[i]!))

/** Field-wise equality of two registry records. */
export function sameUserRecord(a: UserRecordArg, b: UserRecordArg): boolean {
  return (
    sameWord(a.l2Address, b.l2Address) &&
    a.rollupVersion === b.rollupVersion &&
    a.publicKey.x === b.publicKey.x &&
    a.publicKey.y === b.publicKey.y &&
    sameHex(a.resolverOperator, b.resolverOperator)
  )
}

/** The auth key entry a rotation installs for `add`. */
export function backupKeyEntry(add: BackupPasskeyAdd): AuthKeyEntry {
  return { key: add.pubkey, metadata: passkeyMetadata(add.credentialId, backupKeyPayload(add)) }
}

/**
 * Build the rotation over the account as it is now. Refuses an account whose record or key set is
 * not the one the wallet expects; the prepared result records what it was built against.
 */
export async function prepareBackupRotation(
  client: PublicClient,
  args: PrepareBackupRotationArgs,
): Promise<PreparedBackupRotation> {
  const { tuple, owner, recordExpected, add } = args
  const [hasRecord, keys, implementation] = await Promise.all([
    hasUserRecord(client, tuple.metadataRegistry, owner),
    getAuthKeys(client, owner),
    readAddPasskeySIPAImplementation(client, tuple.factory),
  ])
  if (!hasRecord) throw new AccountRecordMismatchError(recordExpected, undefined)
  const record = await getUserRecord(client, tuple.metadataRegistry, owner)
  if (
    !sameWord(record.l2Address, recordExpected.l2Address) ||
    record.rollupVersion !== recordExpected.rollupVersion
  ) {
    throw new AccountRecordMismatchError(recordExpected, record)
  }
  if (keys.length === 0) throw new RootKeyNotInstalledError(owner)
  if (keys.length !== 1 || !sameKey(keys[0]!.key, args.rootKey)) {
    throw new BackupSetConflictError("the keys are not the root key alone", [args.rootKey], keys)
  }
  const rotation = await buildAddPasskeySipa(client, {
    sipaFactory: tuple.factory,
    implementation,
    forwardingTable: tuple.forwardingTable,
    metadataRegistry: tuple.metadataRegistry,
    namePortal: tuple.namePortal,
    rollupVersion: tuple.rollupVersion,
    owner,
    record,
    recipient: args.recipient,
    add: {
      passkey: add.pubkey,
      credentialId: add.credentialId,
      encryptedWalletKey: backupKeyPayload(add),
    },
  })
  return {
    rotation,
    expectedKeys: [...keys],
    implementation,
    sipaFactory: tuple.factory,
    builtOver: record,
    add,
  }
}

/** The latest block, or the number or hash of the block to read at. */
export type AccountStateAt = "latest" | bigint | Hex

/** The block `L1_SETTLED_DEPTH` behind `head`, floored at the genesis block. */
export const settledBlockNumber = (head: bigint): bigint =>
  head > L1_SETTLED_DEPTH ? head - L1_SETTLED_DEPTH : 0n

/** The block read at was replaced while its state was read: the snapshot would mix two blocks. */
export class AccountStateReorgedError extends Error {
  constructor(readonly blockNumber: bigint, readonly expected: Hex, readonly canonical: Hex) {
    super(
      `block ${blockNumber} changed under the read: expected ${expected}, the chain holds ${canonical}`,
    )
    this.name = "AccountStateReorgedError"
  }
}

/** How many times a read at the latest block follows the chain to a new block before giving up. */
const ACCOUNT_STATE_ATTEMPTS = 3

/**
 * The account's nonce, keys and record at one block. A contract that did not exist at the block holds
 * nothing: an undeployed account has no keys and no nonce, an undeployed registry no record. The
 * reads go by block number, so the block is read again afterwards: a read at the latest block follows
 * the chain to the new block, a read at a number or a hash refuses a block the chain no longer holds.
 */
export interface AccountState {
  blockNumber: bigint
  blockHash: Hex
  nonce: bigint
  keys: AuthKeyEntry[]
  record: UserRecordArg | undefined
}

export async function readAccountState(
  client: PublicClient,
  owner: Address,
  options: { metadataRegistry: Address; at?: AccountStateAt },
): Promise<AccountState> {
  const at = options.at ?? "latest"
  for (let attempt = 1; ; attempt++) {
    const block = await client.getBlock(
      typeof at === "bigint"
        ? { blockNumber: at }
        : at === "latest"
        ? { blockTag: at }
        : { blockHash: at },
    )
    // A read that fails under a replaced block is the replacement's doing, not the chain's answer.
    const read = await readStateAt(client, owner, options.metadataRegistry, block.number!).then(
      (state) => ({ state }),
      (error: unknown) => ({ error }),
    )
    const canonical = await client.getBlock({ blockNumber: block.number! })
    if (sameHex(canonical.hash!, block.hash!)) {
      if ("error" in read) throw read.error
      return { ...read.state, blockHash: block.hash! }
    }
    if (at !== "latest" || attempt === ACCOUNT_STATE_ATTEMPTS) {
      throw new AccountStateReorgedError(block.number!, block.hash!, canonical.hash!)
    }
  }
}

async function readStateAt(
  client: PublicClient,
  owner: Address,
  metadataRegistry: Address,
  blockNumber: bigint,
): Promise<Omit<AccountState, "blockHash">> {
  const deployed = async (address: Address) => {
    const code = await client.getCode({ address, blockNumber })
    return code !== undefined && code !== "0x"
  }
  const [entryPointLive, accountLive, registryLive] = await Promise.all([
    deployed(CANONICAL_ENTRY_POINT_V08),
    deployed(owner),
    deployed(metadataRegistry),
  ])
  const [nonce, keys, hasRecord] = await Promise.all([
    entryPointLive
      ? client.readContract({
          address: CANONICAL_ENTRY_POINT_V08,
          abi: EntryPointAbi,
          functionName: "getNonce",
          args: [owner, 0n],
          blockNumber,
        })
      : 0n,
    accountLive
      ? client.readContract({
          address: owner,
          abi: OxideAccountAbi,
          functionName: "getAuthKeys",
          blockNumber,
        })
      : [],
    registryLive
      ? client.readContract({
          address: metadataRegistry,
          abi: AccountMetadataRegistryAbi,
          functionName: "hasUserRecord",
          args: [owner],
          blockNumber,
        })
      : false,
  ])
  const record = hasRecord
    ? await client.readContract({
        address: metadataRegistry,
        abi: AccountMetadataRegistryAbi,
        functionName: "getUserRecord",
        args: [owner],
        blockNumber,
      })
    : undefined
  return {
    blockNumber,
    nonce,
    keys: keys.map((entry) => ({ key: { ...entry.key }, metadata: entry.metadata })),
    record: record && { ...record, publicKey: { ...record.publicKey } },
  }
}

/**
 * Whether the signed operation can still run. `superseded`: the factory now clones another add-passkey
 * implementation, and the subsidy deploys only that one, so funding the SIPA would strand the
 * tokens at a clone no sweep creates. `applied` holds at the settled block (`L1_SETTLED_DEPTH` behind
 * the tip); `applied-pending` is applied at the latest block only.
 */
export type RotationFundability = "fundable" | "superseded" | "applied" | "applied-pending"

/**
 * The chain against the prepared rotation: fundable while nonce, keys and record are as the intent
 * was built and the factory still clones its implementation; superseded once the factory clones
 * another; applied once this very operation ran; anything else is a conflict. Read before the
 * broadcast and before every funding attempt. A settled block that predates the account or the
 * registry reads empty, so it never counts as applied: the answer is `applied-pending` until the
 * settled block shows the operation.
 */
export async function readRotationFundability(
  client: PublicClient,
  prepared: Pick<
    PreparedBackupRotation,
    "rotation" | "expectedKeys" | "builtOver" | "add" | "implementation" | "sipaFactory"
  > & { metadataRegistry: Address },
): Promise<RotationFundability> {
  const { rotation, expectedKeys, builtOver, add, implementation, sipaFactory } = prepared
  const { intent } = rotation
  const fundable = async (): Promise<RotationFundability> =>
    sameHex(
      await readSIPAImplementation(client, sipaFactory, OxideSipaIntent.AddPasskey),
      implementation,
    )
      ? "fundable"
      : "superseded"
  const installed = [...expectedKeys, backupKeyEntry(add)]
  const classify = (state: AccountState): "fundable" | "applied" | undefined => {
    if (
      state.nonce === intent.nonce &&
      sameKeySet(state.keys, expectedKeys) &&
      state.record !== undefined &&
      sameUserRecord(state.record, builtOver)
    ) {
      return "fundable"
    }
    if (
      state.nonce === intent.nonce + 1n &&
      sameKeySet(state.keys, installed) &&
      state.record !== undefined &&
      sameUserRecord(state.record, rotation.newRecord)
    ) {
      return "applied"
    }
    return undefined
  }
  const readAt = async (at: AccountStateAt) => {
    const state = await readAccountState(client, intent.owner, {
      metadataRegistry: prepared.metadataRegistry,
      at,
    })
    return { state, verdict: classify(state) }
  }
  const conflict = (state: AccountState) => {
    const moved =
      state.nonce !== intent.nonce
        ? `the nonce is ${state.nonce}, the intent's is ${intent.nonce}`
        : !sameKeySet(state.keys, expectedKeys)
        ? "the keys changed"
        : "the record changed"
    return new BackupSetConflictError(
      moved,
      expectedKeys.map((entry) => entry.key),
      state.keys,
    )
  }
  const latest = await readAt("latest")
  if (!latest.verdict) throw conflict(latest.state)
  if (latest.verdict === "fundable") return fundable()
  const settled = await readAt(settledBlockNumber(latest.state.blockNumber))
  return settled.verdict === "applied" ? "applied" : "applied-pending"
}

/** The rotation as a device keeps it between signing and the sweep. */
export interface PersistedRotation {
  owner: Address
  intent: AddPasskeyIntent
  sharedSecretSalt: Fr
  nonce: bigint
  builtOver: UserRecordArg
  expectedKeys: AuthKeyEntry[]
  implementation: Address
  deployArgs: SipaDeployArgs
  sipa: Address
  add: BackupPasskeyAdd
  /** The root key's signature over the user-op hash, as `OxideAccount` decodes it. */
  signature: Hex
}

/**
 * What this device knows on its own; the record is bound to it, never to the chain. The resolver
 * operator is not here: the device cannot derive the account's own, and the root key's signature
 * already covers the one the record was built over.
 */
export interface RotationLocalTruth {
  /** The L2 address of a passkey set under this wallet's master key. */
  derive: (keys: readonly R1PublicKeyArg[]) => Promise<AztecAddress> | AztecAddress
  /** The stealth public key the registration wrote into the record. */
  publicKey: { x: bigint; y: bigint }
}

export type PersistedRotationVerdict =
  | {
      verdict: "verified"
      rotation: RotationIntent
      recipient: AztecAddress
      rootKey: AuthKeyEntry
      keyIndex: bigint
    }
  | { verdict: "corrupt"; reason: string }

/**
 * Is the persisted record well formed and the root key's? Every field is judged against the record's
 * own inputs, the tuple and the local truth: the intent must be the one the wallet would build over
 * them, and the signature must cover its hash over the tuple's registry and portal. Live nonce, keys
 * and record are not judged here. A read that does not complete throws
 * `VerificationUnavailableError`; only a completed read that disagrees makes the record corrupt.
 */
export async function verifyPersistedRotation(
  client: PublicClient,
  record: PersistedRotation,
  tuple: BackupRotationTuple,
  truth: RotationLocalTruth,
): Promise<PersistedRotationVerdict> {
  const corrupt = (reason: string): PersistedRotationVerdict => ({ verdict: "corrupt", reason })
  const unavailable = <T>(step: string, run: () => Promise<T>) =>
    run().catch((cause: unknown) => {
      throw new VerificationUnavailableError(step, cause)
    })

  // The reads, the rebuild and the sweep encode the record's fields; one outside its ABI type is
  // corruption, not a read that failed.
  const { deployArgs } = record
  if (
    !isAddress(record.owner, { strict: false }) ||
    !isAddress(record.implementation, { strict: false }) ||
    !isAddress(record.sipa, { strict: false }) ||
    !isHex(record.signature, { strict: true }) ||
    record.signature.length % 2 !== 0
  ) {
    return corrupt("the record's shape")
  }
  try {
    encodeFunctionData({
      abi: AccountMetadataRegistryAbi,
      functionName: "setUserRecord",
      args: [record.owner, record.builtOver],
    })
    encodeAddAuthKey(record.add.pubkey, backupKeyEntry(record.add).metadata)
    for (const expected of record.expectedKeys) encodeAddAuthKey(expected.key, expected.metadata)
    encodeAddPasskeyIntentData(record.intent)
    encodeFunctionData({
      abi: SIPAFactoryAbi,
      functionName: "predictSIPA",
      args: [
        deployArgs.implementation,
        deployArgs.intentHash,
        deployArgs.recoveryCommitment,
        deployArgs.rollupVersion,
        deployArgs.resweepable,
        deployArgs.forwardingTable,
      ],
    })
  } catch {
    return corrupt("the record's shape")
  }

  const [liveKeys, blessedAs] = await Promise.all([
    unavailable("the account's keys", () => getAuthKeys(client, record.owner)),
    unavailable("the factory's blessing", () =>
      readBlessedIntent(client, tuple.factory, record.implementation),
    ),
  ])
  const rootExpected = record.expectedKeys[0]
  if (!rootExpected || record.expectedKeys.length !== 1) {
    return corrupt("the expected key set is not one root key")
  }
  const keyIndex = liveKeys.findIndex((entry) => sameKey(entry.key, rootExpected.key))
  if (keyIndex < 0) return corrupt("the root key is not on the account")
  const rootKey = liveKeys[keyIndex]!
  if (!sameHex(rootExpected.metadata, rootKey.metadata)) {
    return corrupt("the root key's metadata is not the account's")
  }
  if (blessedAs !== OxideSipaIntent.AddPasskey) {
    return corrupt("the implementation is not a blessed add-passkey clone")
  }

  const [recipient, oneKey] = await Promise.all([
    truth.derive([rootKey.key, record.add.pubkey]),
    truth.derive([rootKey.key]),
  ])
  const { intent, builtOver } = record
  if (!sameWord(builtOver.l2Address, oneKey.toString() as Hex)) {
    return corrupt("the record built over names another address")
  }
  if (builtOver.rollupVersion !== tuple.rollupVersion) {
    return corrupt("the record built over names another rollup version")
  }
  if (builtOver.publicKey.x !== truth.publicKey.x || builtOver.publicKey.y !== truth.publicKey.y) {
    return corrupt("the record built over names another public key")
  }

  if (!sameHex(intent.owner, record.owner)) return corrupt("the owner")
  if (intent.rollupVersion !== tuple.rollupVersion) return corrupt("the rollup version")
  if (intent.nonce !== record.nonce) return corrupt("the nonce")
  const recipientCommitment = await computeRecipientCommitment(record.sharedSecretSalt, recipient)
  if (!sameWord(intent.recipientCommitment, recipientCommitment.toString() as Hex)) {
    return corrupt("the recipient commitment")
  }
  const recoveryCommitment = deriveRecoveryCommitment(
    record.sharedSecretSalt,
    EthAddress.fromString(record.owner),
  )
  if (!sameWord(deployArgs.recoveryCommitment, recoveryCommitment.toString() as Hex)) {
    return corrupt("the recovery commitment")
  }
  const intentHash = keccak256(encodeAddPasskeyIntentData(intent))
  if (!sameHex(deployArgs.implementation, record.implementation)) {
    return corrupt("the deploy args' implementation")
  }
  if (!sameWord(deployArgs.intentHash, intentHash)) return corrupt("the intent hash")
  if (
    deployArgs.rollupVersion !== tuple.rollupVersion ||
    deployArgs.resweepable ||
    !sameHex(deployArgs.forwardingTable, tuple.forwardingTable)
  ) {
    return corrupt("the deploy args' plumbing")
  }
  const sipa = computeSIPAAddress({
    sipaFactory: EthAddress.fromString(tuple.factory),
    implementation: EthAddress.fromString(record.implementation),
    intentHash: Buffer.from(hexToBytes(intentHash)),
    recoveryCommitment,
    rollupVersion: tuple.rollupVersion,
    resweepable: false,
    forwardingTable: EthAddress.fromString(tuple.forwardingTable),
  })
  if (!sameHex(sipa.toString(), record.sipa)) return corrupt("the SIPA address")

  // The intent fields the wallet sets, against what it would build over the record's own inputs.
  const newRecord: UserRecordArg = { ...builtOver, l2Address: recipient.toString() as Hex }
  if (!sameUserRecord(intent.record, newRecord)) return corrupt("the record")
  if (!sameWord(intent.namePortalRecipient, recipient.toString() as Hex)) {
    return corrupt("the name-portal recipient")
  }
  if (!sameKey(intent.key, record.add.pubkey)) return corrupt("the key")
  if (!sameHex(intent.metadata, backupKeyEntry(record.add).metadata)) return corrupt("the metadata")
  if (!isAddPasskeyGasLimits(intent.accountGasLimits)) return corrupt("the gas limits")

  const userOpHash = rotationUserOpHash(client, intent, tuple)
  const check = verifyWebAuthnUserOpSignature(record.signature, rootKey.key, userOpHash)
  if (!check.valid) return corrupt(`the signature: ${check.reason}`)
  if (check.keyIndex !== BigInt(keyIndex)) return corrupt("the signature's key index")

  return {
    verdict: "verified",
    rotation: {
      sharedSecretSalt: record.sharedSecretSalt,
      newRecord,
      intent,
      deployArgs,
      sipa: record.sipa,
      userOpHash,
    },
    recipient,
    rootKey,
    keyIndex: BigInt(keyIndex),
  }
}

const U128_MASK = (1n << 128n) - 1n

/**
 * Whether packed gas limits are ones oxide's add-passkey builder signs: its verification gas, and a
 * call gas from its chain estimate, which it caps. The only limits the wallet signs or verifies.
 */
export function isAddPasskeyGasLimits(accountGasLimits: Hex): boolean {
  // The operation hash encodes the word as written, so only its 32-byte spelling is the value checked.
  if (!/^0x[0-9a-fA-F]{64}$/.test(accountGasLimits)) return false
  const word = BigInt(accountGasLimits)
  const callGas = word & U128_MASK
  return (
    word >> 128n === USER_OP_VERIFICATION_GAS && callGas > 0n && callGas <= MAX_ADD_PASSKEY_CALL_GAS
  )
}

/** The clone's immutable targets: the registry the record is written to and the portal it notifies. */
export interface RotationTargets {
  metadataRegistry: Address
  namePortal: Address
}

/** The hash the root key signs: the canonical entry point's, over the operation for `targets`. */
export function rotationUserOpHash(
  client: PublicClient,
  intent: AddPasskeyIntent,
  targets: RotationTargets,
): Hex {
  return computeUserOpHash(
    configuredChainId(client),
    CANONICAL_ENTRY_POINT_V08,
    buildAddPasskeyUserOp(intent, targets),
  )
}

const WEBAUTHN_GET = new TextEncoder().encode('"type":"webauthn.get"')
const P256_HALF_N = p256.CURVE.n / 2n
// `clientDataJSON` is a `string` on-chain and decoded here as `bytes`, the same encoding: the account
// slices and hashes its raw bytes, which a string decoder would not keep byte for byte.
const WEBAUTHN_AUTH = parseAbiParameters(
  "bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, bytes clientDataJSON",
)

const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Whether `needle` sits in `haystack` at byte offset `at`, as the Solidity slice compares it. */
const bytesAt = (haystack: Uint8Array, at: bigint, needle: Uint8Array) =>
  at + BigInt(needle.length) <= BigInt(haystack.length) &&
  needle.every((byte, i) => haystack[Number(at) + i] === byte)

const WORD = 1n << 256n
/**
 * Whether the type field sits at `typeIndex`, read as the account's assembly reads it: 21 bytes at
 * that index into the in-memory string, the offset wrapping at 2^256 into the length word in front
 * of the data.
 */
const typeAt = (clientData: Uint8Array, typeIndex: bigint) => {
  if (BigInt(clientData.length) <= (typeIndex + 20n) % WORD) return false
  const memory = new Uint8Array(64 + clientData.length)
  memory.set(numberToBytes(clientData.length, { size: 32 }))
  memory.set(clientData, 32)
  const at = Number((typeIndex + 32n) % WORD)
  return WEBAUTHN_GET.every((byte, i) => memory[at + i] === byte)
}

export type UserOpSignatureCheck =
  | { valid: true; keyIndex: bigint }
  | { valid: false; keyIndex?: bigint; reason: string }

/**
 * Checks a user-op signature as `OxideAccount._rawSignatureValidation` does: the key index word,
 * then OpenZeppelin's `WebAuthn.verify` with user verification required over `userOpHash` as the
 * challenge. Mirrored because no oxide package exports the check off-chain; the sandbox suite runs
 * the same vectors through the account and this function, and `docs/account/README.md` names the
 * owner of the mirror.
 */
export function verifyWebAuthnUserOpSignature(
  signature: Hex,
  key: R1PublicKeyArg,
  userOpHash: Hex,
): UserOpSignatureCheck {
  if (signature.length % 2 !== 0) return { valid: false, reason: "not whole bytes" }
  if (hexToBytes(signature).length < 32) return { valid: false, reason: "no key index" }
  const keyIndex = BigInt(slice(signature, 0, 32))
  const refuse = (reason: string): UserOpSignatureCheck => ({ valid: false, keyIndex, reason })
  let auth: readonly [Hex, Hex, bigint, bigint, Hex, Hex]
  try {
    auth = decodeAbiParameters(WEBAUTHN_AUTH, slice(signature, 32))
  } catch {
    return refuse("the assertion does not decode")
  }
  const [r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON] = auth
  const authData = hexToBytes(authenticatorData)
  if (authData.length < 37) return refuse("the authenticator data is short")
  const flags = authData[32]!
  const present = (flags & 0x01) !== 0
  const verified = (flags & 0x04) !== 0
  const backupEligible = (flags & 0x08) !== 0
  const backedUp = (flags & 0x10) !== 0
  if (!present || !verified || (!backupEligible && backedUp)) return refuse("the flags")
  const clientData = hexToBytes(clientDataJSON)
  if (!typeAt(clientData, typeIndex)) return refuse("the type")
  const challenge = new TextEncoder().encode(`"challenge":"${base64url(hexToBytes(userOpHash))}"`)
  if (!bytesAt(clientData, challengeIndex, challenge)) return refuse("the challenge")
  const rn = BigInt(r)
  const sn = BigInt(s)
  if (rn === 0n || rn >= p256.CURVE.n || sn === 0n || sn > P256_HALF_N) {
    return refuse("the signature's range")
  }
  const message = sha256(new Uint8Array([...authData, ...sha256(clientData)]))
  const publicKey = new Uint8Array([
    0x04,
    ...hexToBytes(toHex(BigInt(key.qx), { size: 32 })),
    ...hexToBytes(toHex(BigInt(key.qy), { size: 32 })),
  ])
  const compact = new Uint8Array([...hexToBytes(r), ...hexToBytes(s)])
  let valid = false
  try {
    valid = p256.verify(compact, message, publicKey, { lowS: true, prehash: false })
  } catch {
    valid = false
  }
  return valid ? { valid: true, keyIndex } : refuse("the signature does not verify")
}

/**
 * The deploy-and-sweep operation that runs a signed rotation, through the tuple's deposit subsidy
 * once the SIPA holds the token. Refuses a subsidy that would not deploy this SIPA.
 */
export async function buildBackupSweep(
  client: PublicClient,
  rotation: RotationIntent,
  signature: Hex,
  tuple: BackupRotationTuple,
): Promise<BroadcastL1Operation> {
  const operation = buildAddPasskeySweep(rotation, signature, {
    sipaFactory: tuple.factory,
    token: tuple.token,
    operationExecutor: tuple.operationExecutor,
    depositSubsidy: tuple.depositSubsidy,
    condition: L1OperationCondition.balance(
      EthAddress.fromString(tuple.token),
      EthAddress.fromString(rotation.sipa),
    ),
  })
  await assertSubsidySweepsSipa(client, {
    routes: [{ portal: tuple.portal, depositSubsidy: tuple.depositSubsidy }],
    sipaFactory: tuple.factory,
    intent: OxideSipaIntent.AddPasskey,
    deployArgs: rotation.deployArgs,
    intentData: encodeAddPasskeyIntentData(rotation.intent),
    sipa: rotation.sipa,
  })
  return operation
}

/** Credited on top of the subsidy's minimum, so a rounding or a fee bump never leaves it short. */
export const BACKUP_FUNDING_MARGIN = 5n * 10n ** 17n

export interface FundingAmount {
  /** What the one-key account withdraws to the SIPA. */
  amount: bigint
  /** What the two-key account receives on L2 once the SIPA is swept. */
  credited: bigint
  breakdown: {
    withdrawalFee: bigint
    proverTip: bigint
    relayerTip: bigint
    sweepTip: bigint
    beneficiaryFee: bigint
    minCredited: bigint
    margin: bigint
  }
}

/**
 * The withdrawal that funds the sweep: every charge on the way to L2 plus a credit the subsidy pays
 * for. The withdrawal fee is the plain executor's own, not the deposit row's. Refuses a route no
 * relayer is paid to sweep.
 */
export async function fundingAmount(
  client: PublicClient,
  args: { tuple: BackupRotationTuple; plainWithdrawalExecutor: Address; proverTip: bigint },
): Promise<FundingAmount> {
  const { tuple, proverTip } = args
  const [withdrawalFee, route] = await Promise.all([
    readPlainWithdrawalFee(client, EthAddress.fromString(args.plainWithdrawalExecutor)),
    readSweepRouteLiveness(client, {
      forwardingTable: tuple.forwardingTable,
      token: tuple.token,
      depositSubsidy: tuple.depositSubsidy,
      intent: OxideSipaIntent.AddPasskey,
    }),
  ])
  if (!route.live) throw new RotationRouteNotLiveError(route.reason)
  const { row, config } = route
  const minCredited = config.minCreditedAmount > 1n ? config.minCreditedAmount : 1n
  const credited = minCredited + BACKUP_FUNDING_MARGIN
  const amount =
    withdrawalFee + proverTip + WITHDRAW_RELAYER_TIP + row.sweepTip + row.beneficiaryFee + credited
  assertPlainWithdrawalTip(amount, proverTip, WITHDRAW_RELAYER_TIP, withdrawalFee)
  return {
    amount,
    credited,
    breakdown: {
      withdrawalFee,
      proverTip,
      relayerTip: WITHDRAW_RELAYER_TIP,
      sweepTip: row.sweepTip,
      beneficiaryFee: row.beneficiaryFee,
      minCredited,
      margin: BACKUP_FUNDING_MARGIN,
    },
  }
}
