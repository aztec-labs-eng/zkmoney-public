import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  AccountMetadataRegistryAbi,
  CANONICAL_ENTRY_POINT_V08,
  type R1PublicKeyArg,
  type SipaDeployArgs,
  SipaIntent,
  type UserOpIntent,
  type UserRecordArg,
  buildSipaDeployAndSweepOperation,
  conditionHash,
  encodeAddAuthKey,
  encodeExecuteBatch,
  encodeRemoveAuthKey,
  encodeSetUserRecord,
  encodeUserOpIntentData,
  encodeUserOpProofs,
  getAccountNonce,
  getAuthKeys,
  getUserOpHash,
  packU128LimbsToBytes32,
  predictSIPA,
  readConditionHash,
  userOpOfIntent,
} from '@oxide/l1-contracts';
import type { BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { computeRecipientCommitment } from '@oxide/oxide-lib/recipient_commitment.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import {
  type Address,
  type Hex,
  type PublicClient,
  bytesToHex,
  concat,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  stringToHex,
} from 'viem';

import { USER_OP_VERIFICATION_GAS, recordUpdateCalls } from './record_update.js';

/**
 * A passkey's auth key metadata: version (1 byte) ‖ keccak256(tag ‖ credential ID) ‖ encrypted wallet key. The
 * account's original passkey has empty metadata.
 */
export function passkeyMetadata(credentialId: Hex, encryptedWalletKey: Hex): Hex {
  return concat([metadataPrefix(credentialId), encryptedWalletKey]);
}

/**
 * The auth key of `owner` whose metadata names `credentialId`, or undefined when none does. A key removal can move the
 * key to another index, so read the index again before each signature.
 */
export async function findPasskey(
  publicClient: PublicClient,
  owner: Address,
  credentialId: Hex,
): Promise<{ index: bigint; passkey: R1PublicKeyArg; encryptedWalletKey: Hex } | undefined> {
  const prefix = metadataPrefix(credentialId);
  const authKeys = await getAuthKeys(publicClient, owner);
  const index = authKeys.findIndex(({ metadata }) => metadata.toLowerCase().startsWith(prefix));
  if (index < 0) {
    return undefined;
  }
  const { key, metadata } = authKeys[index];
  return { index: BigInt(index), passkey: key, encryptedWalletKey: `0x${metadata.slice(prefix.length)}` };
}

/** A rotation's intent, its SIPA, and the user operation hash that the account's signer signs. */
export interface RotationIntent {
  sharedSecretSalt: Fr;
  newRecord: UserRecordArg;
  intent: UserOpIntent;
  deployArgs: SipaDeployArgs;
  sipa: Address;
  userOpHash: Hex;
}

/**
 * A rotation of `owner` to `recipient`: one user operation adds the `add` passkeys, removes the `remove` ones, and
 * points the record to `recipient`. The deposit subsidy covers the gas of one add and one remove, so a larger rotation
 * costs the relayer more than the subsidy pays.
 */
export async function buildRotationIntent(
  publicClient: PublicClient,
  args: {
    sipaFactory: Address;
    implementation: Address;
    forwardingTable: Address;
    metadataRegistry: Address;
    namePortal: Address;
    rollupVersion: bigint;
    owner: Address;
    /** The owner's record before the rotation. */
    record: UserRecordArg;
    recipient: AztecAddress;
    add: { passkey: R1PublicKeyArg; credentialId: Hex; encryptedWalletKey: Hex }[];
    remove: R1PublicKeyArg[];
  },
): Promise<RotationIntent> {
  const { owner, metadataRegistry, rollupVersion } = args;
  const newRecord: UserRecordArg = { ...args.record, l2Address: args.recipient.toString() as Hex };
  const sharedSecretSalt = Fr.random();
  const readRecord = encodeFunctionData({
    abi: AccountMetadataRegistryAbi,
    functionName: 'getUserRecord',
    args: [owner],
  });
  const [nonce, preconditionHash, recipientCommitment, authKeys] = await Promise.all([
    getAccountNonce(publicClient, CANONICAL_ENTRY_POINT_V08, owner),
    readConditionHash(publicClient, metadataRegistry, readRecord),
    computeRecipientCommitment(sharedSecretSalt, args.recipient),
    args.remove.length > 0 ? getAuthKeys(publicClient, owner) : [],
  ]);
  const changed = [...args.add.map(({ passkey }) => passkey), ...args.remove];
  const repeated = changed.find((a, i) => changed.findIndex(b => sameKey(a, b)) !== i);
  if (repeated) {
    throw new Error(`A rotation changes each passkey once, but it changes passkey ${repeated.qx} twice`);
  }
  if (args.remove.length > 0 && authKeys.length + args.add.length - args.remove.length < 1) {
    throw new Error('A rotation must leave the account at least one passkey');
  }
  // The batch adds first, so a removal never takes the account's last key. Removal swaps the last key into the removed
  // slot, so the batch removes from the highest index down.
  const removals = args.remove
    .map(passkey => {
      const index = authKeys.findIndex(({ key }) => sameKey(key, passkey));
      if (index < 0) {
        throw new Error(`The account ${owner} has no passkey ${passkey.qx}`);
      }
      return { index: BigInt(index), passkey };
    })
    .sort((a, b) => Number(b.index - a.index));
  const intent: UserOpIntent = {
    owner,
    nonce,
    callData: encodeExecuteBatch([
      ...args.add.map(({ passkey, credentialId, encryptedWalletKey }) => ({
        target: owner,
        value: 0n,
        data: encodeAddAuthKey(passkey, passkeyMetadata(credentialId, encryptedWalletKey)),
      })),
      ...removals.map(({ index, passkey }) => ({
        target: owner,
        value: 0n,
        data: encodeRemoveAuthKey(index, passkey),
      })),
      ...recordUpdateCalls({
        owner,
        metadataRegistry,
        writeData: encodeSetUserRecord(owner, newRecord),
        namePortal: args.namePortal,
        namePortalRecipient: args.recipient.toString() as Hex,
        rollupVersion,
      }),
    ]),
    accountGasLimits: packU128LimbsToBytes32(
      USER_OP_VERIFICATION_GAS,
      CALL_GAS + ADD_GAS * BigInt(args.add.length) + REMOVE_GAS * BigInt(removals.length),
    ),
    precondition: {
      target: metadataRegistry,
      data: readRecord,
      resultHash: preconditionHash,
    },
    postcondition: {
      target: metadataRegistry,
      data: readRecord,
      resultHash: conditionHash(
        encodeFunctionResult({ abi: AccountMetadataRegistryAbi, functionName: 'getUserRecord', result: newRecord }),
      ),
    },
    rollupVersion,
    recipientCommitment: bytesToHex(recipientCommitment.toBuffer()),
  };
  const deployArgs: SipaDeployArgs = {
    implementation: args.implementation,
    intentHash: keccak256(encodeUserOpIntentData(intent)),
    recoveryCommitment: deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(owner)).toString() as Hex,
    rollupVersion,
    resweepable: false,
    forwardingTable: args.forwardingTable,
  };
  const sipa = await predictSIPA(
    publicClient,
    args.sipaFactory,
    deployArgs.implementation,
    deployArgs.intentHash,
    deployArgs.recoveryCommitment,
    rollupVersion,
    deployArgs.resweepable,
    deployArgs.forwardingTable,
  );
  const userOpHash = await getUserOpHash(publicClient, CANONICAL_ENTRY_POINT_V08, userOpOfIntent(intent));
  return { sharedSecretSalt, newRecord, intent, deployArgs, sipa, userOpHash };
}

/** The operation that deploys and sweeps a signed rotation's SIPA. */
export function buildRotationSweep(
  rotation: RotationIntent,
  signature: Hex,
  args: {
    sipaFactory: Address;
    token: Address;
    operationExecutor: Address;
    depositSubsidy: Address;
    condition: L1OperationCondition;
  },
): BroadcastL1Operation {
  return buildSipaDeployAndSweepOperation({
    sipa: rotation.sipa,
    sipaFactory: args.sipaFactory,
    intent: SipaIntent.UserOp,
    deployArgs: rotation.deployArgs,
    sweepArgs: {
      token: args.token,
      relayer: args.operationExecutor,
      intentData: encodeUserOpIntentData(rotation.intent),
      proofs: encodeUserOpProofs(signature),
    },
    depositSubsidy: args.depositSubsidy,
    payoutToken: args.token,
    condition: args.condition,
  });
}

/** The metadata version and the credential ID hash, which start a passkey's metadata. */
function metadataPrefix(credentialId: Hex): Hex {
  return concat([PASSKEY_METADATA_VERSION, keccak256(concat([CREDENTIAL_ID_TAG, credentialId]))]);
}

function sameKey(a: R1PublicKeyArg, b: R1PublicKeyArg): boolean {
  return BigInt(a.qx) === BigInt(b.qx) && BigInt(a.qy) === BigInt(b.qy);
}

// Each call gas limit is about 1.5 times the gas that a rotation used in a test. The calls overwrite the record and
// notify the name portal (122k), and each add (141k) and each remove (101k) adds to them.
const CALL_GAS = 185_000n;
const ADD_GAS = 215_000n;
const REMOVE_GAS = 155_000n;

/** The version of the passkey metadata format. */
const PASSKEY_METADATA_VERSION: Hex = '0x01';
/** The domain tag of a credential ID hash in passkey metadata. */
const CREDENTIAL_ID_TAG = stringToHex('oxide.passkey.credential-id.v1');
