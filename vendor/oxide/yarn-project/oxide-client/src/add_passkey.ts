import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  type AddPasskeyIntent,
  AddPasskeySIPAAbi,
  CANONICAL_ENTRY_POINT_V08,
  type PackedUserOperation,
  type R1PublicKeyArg,
  type SipaDeployArgs,
  SipaIntent,
  type UserRecordArg,
  buildSipaDeployAndSweepOperation,
  computeUserOpHash,
  encodeAddAuthKey,
  encodeAddPasskeyIntentData,
  encodeAddPasskeyProofs,
  encodeExecuteBatch,
  encodeSetUserRecord,
  getAccountNonce,
  getAuthKeys,
  packU128LimbsToBytes32,
  predictSIPA,
  readAccountMetadataRegistry,
} from '@oxide/l1-contracts';
import { padGasEstimate } from '@oxide/l1-contracts/write_receipt.js';
import type { BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { computeRecipientCommitment } from '@oxide/oxide-lib/recipient_commitment.js';
import { computeSIPAAddress } from '@oxide/oxide-lib/sipa_address.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import {
  type Address,
  type Hex,
  type PublicClient,
  bytesToHex,
  concat,
  hexToBytes,
  isAddressEqual,
  keccak256,
  stringToHex,
} from 'viem';

import { SIMULATED_SENDER_BALANCE } from './l1_operation_quote.js';
import { USER_OP_VERIFICATION_GAS, configuredChainId, intrinsicGas, recordUpdateCalls } from './record_update.js';

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

/** An add-passkey intent, its SIPA, and the user operation hash that the account's signer signs. */
export type AddPasskeySipa = {
  sharedSecretSalt: Fr;
  newRecord: UserRecordArg;
  intent: AddPasskeyIntent;
  deployArgs: SipaDeployArgs;
  sipa: Address;
  userOpHash: Hex;
};

/**
 * An add-passkey SIPA of `owner`: one user operation adds the `add` passkey and points the record to `recipient`. The
 * operation writes the record to `metadataRegistry` and notifies `namePortal`. Its call gas comes from a gas estimate
 * on the chain, so it follows the gas costs of the chain.
 */
export async function buildAddPasskeySipa(
  publicClient: PublicClient,
  args: {
    sipaFactory: Address;
    implementation: Address;
    forwardingTable: Address;
    metadataRegistry: Address;
    namePortal: Address;
    rollupVersion: bigint;
    owner: Address;
    /** The owner's record before the passkey addition. */
    record: UserRecordArg;
    recipient: AztecAddress;
    add: { passkey: R1PublicKeyArg; credentialId: Hex; encryptedWalletKey: Hex };
  },
): Promise<AddPasskeySipa> {
  const { owner, rollupVersion } = args;
  const chainId = configuredChainId(publicClient);
  if (args.record.rollupVersion !== rollupVersion) {
    throw new Error(
      `The record names rollup version ${args.record.rollupVersion}, but the passkey addition names ${rollupVersion}`,
    );
  }
  if (args.recipient.isZero()) {
    throw new Error('A passkey addition needs a recipient that is not zero');
  }
  const newRecord: UserRecordArg = { ...args.record, l2Address: args.recipient.toString() as Hex };
  const sharedSecretSalt = Fr.random();
  const [nonce, recipientCommitment] = await Promise.all([
    getAccountNonce(publicClient, CANONICAL_ENTRY_POINT_V08, owner),
    computeRecipientCommitment(sharedSecretSalt, args.recipient),
    checkSipaTargets(publicClient, args.implementation, args),
  ]);
  const calls = {
    rollupVersion,
    owner,
    record: newRecord,
    namePortalRecipient: args.recipient.toString() as Hex,
    key: args.add.passkey,
    metadata: passkeyMetadata(args.add.credentialId, args.add.encryptedWalletKey),
  };
  const callGas = await addPasskeyCallGas(publicClient, owner, addPasskeyCallData(calls, args));
  const intent: AddPasskeyIntent = {
    ...calls,
    recipientCommitment: bytesToHex(recipientCommitment.toBuffer()),
    nonce,
    accountGasLimits: packU128LimbsToBytes32(USER_OP_VERIFICATION_GAS, callGas),
  };
  const recoveryCommitment = deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(owner));
  const deployArgs: SipaDeployArgs = {
    implementation: args.implementation,
    intentHash: keccak256(encodeAddPasskeyIntentData(intent)),
    recoveryCommitment: recoveryCommitment.toString() as Hex,
    rollupVersion,
    resweepable: false,
    forwardingTable: args.forwardingTable,
  };
  const sipa = computeSIPAAddress({
    sipaFactory: EthAddress.fromString(args.sipaFactory),
    implementation: EthAddress.fromString(deployArgs.implementation),
    intentHash: Buffer.from(hexToBytes(deployArgs.intentHash)),
    recoveryCommitment,
    rollupVersion,
    resweepable: deployArgs.resweepable,
    forwardingTable: EthAddress.fromString(deployArgs.forwardingTable),
  }).toChecksumString();
  let predicted: Address;
  try {
    predicted = await predictSIPA(
      publicClient,
      args.sipaFactory,
      deployArgs.implementation,
      deployArgs.intentHash,
      deployArgs.recoveryCommitment,
      rollupVersion,
      deployArgs.resweepable,
      deployArgs.forwardingTable,
    );
  } catch (err) {
    throw new Error(`The SIPA factory ${args.sipaFactory} did not confirm the SIPA ${sipa}`, { cause: err });
  }
  if (!isAddressEqual(predicted, sipa)) {
    throw new Error(`The SIPA factory ${args.sipaFactory} predicts ${predicted}, not the SIPA ${sipa}`);
  }
  const userOpHash = computeUserOpHash(chainId, CANONICAL_ENTRY_POINT_V08, buildAddPasskeyUserOp(intent, args));
  return { sharedSecretSalt, newRecord, intent, deployArgs, sipa, userOpHash };
}

/** The operation that deploys and sweeps a signed add-passkey SIPA. */
export function buildAddPasskeySweep(
  addition: AddPasskeySipa,
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
    sipa: addition.sipa,
    sipaFactory: args.sipaFactory,
    intent: SipaIntent.AddPasskey,
    deployArgs: addition.deployArgs,
    sweepArgs: {
      token: args.token,
      relayer: args.operationExecutor,
      intentData: encodeAddPasskeyIntentData(addition.intent),
      proofs: encodeAddPasskeyProofs(signature),
    },
    depositSubsidy: args.depositSubsidy,
    payoutToken: args.token,
    condition: args.condition,
  });
}

/** Throws unless the AddPasskey SIPA `implementation` writes to `metadataRegistry` and notifies `namePortal`. */
async function checkSipaTargets(
  publicClient: PublicClient,
  implementation: Address,
  targets: { metadataRegistry: Address; namePortal: Address },
): Promise<void> {
  const [nameRegistry, namePortal] = await Promise.all([
    publicClient.readContract({ address: implementation, abi: AddPasskeySIPAAbi, functionName: 'NAME_REGISTRY' }),
    publicClient.readContract({ address: implementation, abi: AddPasskeySIPAAbi, functionName: 'NAME_PORTAL' }),
  ]);
  if (!isAddressEqual(namePortal, targets.namePortal)) {
    throw new Error(
      `The AddPasskey SIPA ${implementation} notifies the name portal ${namePortal}, not ${targets.namePortal}`,
    );
  }
  const metadataRegistry = await readAccountMetadataRegistry(publicClient, nameRegistry);
  if (!isAddressEqual(metadataRegistry, targets.metadataRegistry)) {
    throw new Error(`The current metadata registry is ${metadataRegistry}, not ${targets.metadataRegistry}`);
  }
}

/** The user operation that the SIPA submits for `intent`, without its signature. */
export function buildAddPasskeyUserOp(
  intent: AddPasskeyIntent,
  targets: { metadataRegistry: Address; namePortal: Address },
): PackedUserOperation {
  return {
    sender: intent.owner,
    nonce: intent.nonce,
    initCode: '0x',
    callData: addPasskeyCallData(intent, targets),
    accountGasLimits: intent.accountGasLimits,
    preVerificationGas: 0n,
    gasFees: `0x${'00'.repeat(32)}`,
    paymasterAndData: '0x',
    signature: '0x',
  };
}

/** The account call of a passkey addition: it adds the passkey, writes the record and notifies the name portal. */
function addPasskeyCallData(
  intent: Pick<AddPasskeyIntent, 'owner' | 'key' | 'metadata' | 'record' | 'namePortalRecipient' | 'rollupVersion'>,
  targets: { metadataRegistry: Address; namePortal: Address },
): Hex {
  return encodeExecuteBatch([
    { target: intent.owner, value: 0n, data: encodeAddAuthKey(intent.key, intent.metadata) },
    ...recordUpdateCalls({
      owner: intent.owner,
      metadataRegistry: targets.metadataRegistry,
      writeData: encodeSetUserRecord(intent.owner, intent.record),
      namePortal: targets.namePortal,
      namePortalRecipient: intent.namePortalRecipient,
      rollupVersion: intent.rollupVersion,
    }),
  ]);
}

/**
 * The call gas of a passkey addition: {@link padGasEstimate} of the gas that the EntryPoint uses to run `callData` on
 * `owner` now, less the intrinsic gas of a transaction, which the account call does not use. Throws when the run fails
 * or when the call gas is more than {@link MAX_ADD_PASSKEY_CALL_GAS}.
 */
async function addPasskeyCallGas(publicClient: PublicClient, owner: Address, callData: Hex): Promise<bigint> {
  let estimate: bigint;
  try {
    estimate = await publicClient.estimateGas({
      account: CANONICAL_ENTRY_POINT_V08,
      to: owner,
      data: callData,
      // A node caps an estimate at what the sender's balance pays for, and the EntryPoint can hold no ETH.
      stateOverride: [{ address: CANONICAL_ENTRY_POINT_V08, balance: SIMULATED_SENDER_BALANCE }],
    });
  } catch (err) {
    throw new Error('The passkey addition fails in a gas estimate', { cause: err });
  }
  const callGas = padGasEstimate(estimate - intrinsicGas(callData));
  if (callGas > MAX_ADD_PASSKEY_CALL_GAS) {
    throw new Error(`The passkey addition needs ${callGas} call gas, more than ${MAX_ADD_PASSKEY_CALL_GAS}`);
  }
  return callGas;
}

/** The metadata version and the credential ID hash, which start a passkey's metadata. */
function metadataPrefix(credentialId: Hex): Hex {
  return concat([PASSKEY_METADATA_VERSION, keccak256(concat([CREDENTIAL_ID_TAG, credentialId]))]);
}

/**
 * The most call gas that a passkey addition signs. The relayer's gas limit must be more than the call gas, so the cap
 * keeps the sweep in the relayer's simulation gas.
 */
export const MAX_ADD_PASSKEY_CALL_GAS = 4_000_000n;

/** The version of the passkey metadata format. */
const PASSKEY_METADATA_VERSION: Hex = '0x01';
/** The domain tag of a credential ID hash in passkey metadata. */
const CREDENTIAL_ID_TAG = stringToHex('oxide.passkey.credential-id.v1');
