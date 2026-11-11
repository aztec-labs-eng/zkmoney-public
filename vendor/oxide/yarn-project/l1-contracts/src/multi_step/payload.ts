import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters, hexToBytes, parseAbiParameters } from 'viem';

import { assertRecoveryCommitment } from '../escrow.js';

export type MultiStepCall = {
  target: Address;
  data: Hex;
};

export type MultiStepTransfer = {
  amount: bigint;
  recipient: Address;
};

export type MultiStepPayload = {
  /** Paid to the tip recipient of the relayer payload. */
  relayerTip: bigint;
  /** Opens to the account that signs `recover`. */
  recoveryCommitment: Hex;
  remainderRecipient: Address;
  transfers: MultiStepTransfer[];
  steps: MultiStepCall[];
};

export function encodeMultiStepPayload(payload: MultiStepPayload): Buffer {
  assertRecoveryCommitment(payload.recoveryCommitment);
  return encodeBytes(payload);
}

// TODO(OX-2342): Compact the recovery chunks of a multi-step withdrawal with this decoder.
export function decodeMultiStepPayload(payload: Buffer): MultiStepPayload {
  const [decoded] = decodeAbiParameters(PAYLOAD_PARAMETERS, `0x${payload.toString('hex')}`);
  const result: MultiStepPayload = {
    relayerTip: decoded.relayerTip,
    recoveryCommitment: decoded.recoveryCommitment,
    remainderRecipient: decoded.remainderRecipient,
    transfers: decoded.transfers.map(t => ({ amount: t.amount, recipient: t.recipient })),
    steps: decoded.steps.map(s => ({ target: s.target, data: s.data })),
  };
  if (!encodeBytes(result).equals(payload)) {
    throw new Error('Multi-step payload is not in canonical ABI encoding');
  }
  return result;
}

function encodeBytes(payload: MultiStepPayload): Buffer {
  return Buffer.from(hexToBytes(encodeAbiParameters(PAYLOAD_PARAMETERS, [payload])));
}

const PAYLOAD_PARAMETERS = parseAbiParameters(
  '(uint256 relayerTip, bytes32 recoveryCommitment, address remainderRecipient, (uint256 amount, address recipient)[] transfers, (address target, bytes data)[] steps)',
);
