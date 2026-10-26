import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { type Hex, decodeAbiParameters, encodeAbiParameters } from 'viem';

import { type ExecutorCall, assertPayloadLength, encodeExecutorRelayerPayload } from './executor.js';

const USER_PAYLOAD_PARAMETERS = [{ type: 'bytes32' }, { type: 'uint256' }] as const;
const USER_PAYLOAD_BYTES = 64;

/**
 * The user payload of `MigrationExecutor`. The executor deposits the amount less `relayerTip` into the new portal under
 * `recipientCommitment`, and pays `relayerTip` to the tip recipient.
 */
export interface MigrationPayload {
  /** The deposit commitment on the new portal; see `computeRecipientCommitment`. */
  recipientCommitment: Fr;
  /**
   * The tip in the migrated asset, paid to the tip recipient. The executor accepts a nonzero tip only when the asset is
   * the payout token of its subsidy; for any other asset the tip must be 0.
   */
  relayerTip: bigint;
}

/** A recipient commitment as a field or a 32-byte hex string. */
export type RecipientCommitmentInput = Fr | Hex;

export function encodeMigrationPayload(payload: {
  recipientCommitment: RecipientCommitmentInput;
  relayerTip: bigint;
}): Buffer {
  const recipientCommitment = toRecipientCommitment(payload.recipientCommitment);
  if (payload.relayerTip < 0n) {
    throw new Error('Migration relayer tip must not be negative.');
  }
  return Buffer.from(
    encodeAbiParameters(USER_PAYLOAD_PARAMETERS, [recipientCommitment.toString() as Hex, payload.relayerTip]).slice(2),
    'hex',
  );
}

export function decodeMigrationPayload(payload: Buffer): MigrationPayload {
  assertPayloadLength(payload, USER_PAYLOAD_BYTES, 'Migration user');
  const [recipientCommitment, relayerTip] = decodeAbiParameters(
    USER_PAYLOAD_PARAMETERS,
    `0x${payload.toString('hex')}`,
  );
  return { recipientCommitment: toRecipientCommitment(recipientCommitment), relayerTip };
}

/**
 * The amount that the executor deposits into the new portal: the executor amount less the tip. Throws when the
 * executor rejects the migration: the tip is more than the executor amount, or nothing stays to migrate.
 */
export function migratedAmount(executorAmount: bigint, relayerTip: bigint): bigint {
  if (relayerTip > executorAmount) {
    throw new Error(`Migration relayer tip ${relayerTip} exceeds the executor amount ${executorAmount}.`);
  }
  if (relayerTip === executorAmount) {
    throw new Error('Migration leaves nothing to deposit into the new portal.');
  }
  return executorAmount - relayerTip;
}

/**
 * Build the executor call that routes a refund or a withdrawal of an old portal through `MigrationExecutor`. The
 * executor deposits the amount less `relayerTip` into the new portal under `recipientCommitment`.
 *
 * `relayerTip` defaults to 0 and `tipRecipient` defaults to the zero address. The executor accepts a nonzero tip only
 * when the asset is the payout token of its subsidy, and then it rejects a zero `tipRecipient`. The `MigrationSubsidy`
 * pays the relayer whatever the tip and the tip recipient are.
 */
export function buildMigrationExecutorCall(args: {
  executor: EthAddress;
  recipientCommitment: RecipientCommitmentInput;
  relayerTip?: bigint;
  tipRecipient?: EthAddress;
}): ExecutorCall {
  const relayerTip = args.relayerTip ?? 0n;
  const userPayload = encodeMigrationPayload({ recipientCommitment: args.recipientCommitment, relayerTip });
  const relayerPayload = encodeExecutorRelayerPayload({ tipRecipient: args.tipRecipient ?? EthAddress.ZERO });
  return { executor: args.executor, userPayload, relayerPayload };
}

/**
 * The commitment as a field. Throws when it is zero, which the executor rejects, or when it is not a field element,
 * which the Inbox of the new portal rejects.
 */
function toRecipientCommitment(input: RecipientCommitmentInput): Fr {
  let commitment: Fr;
  if (input instanceof Fr) {
    commitment = input;
  } else {
    const bytes = Buffer.from(input.replace(/^0x/, ''), 'hex');
    if (bytes.length !== Fr.SIZE_IN_BYTES) {
      throw new Error(`Migration recipient commitment must contain exactly ${Fr.SIZE_IN_BYTES} bytes.`);
    }
    try {
      commitment = Fr.fromBuffer(bytes);
    } catch {
      throw new Error('Migration recipient commitment is not a field element.');
    }
  }
  if (commitment.isZero()) {
    throw new Error('Migration recipient commitment must not be zero.');
  }
  return commitment;
}
