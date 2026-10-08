import { EthAddress } from '@aztec/foundation/eth-address';

import { type Hex, decodeAbiParameters, encodeAbiParameters } from 'viem';

const USER_PAYLOAD_PARAMETERS = [{ type: 'address' }, { type: 'uint256' }] as const;
const RELAYER_PAYLOAD_PARAMETERS = [{ type: 'address' }, { type: 'address' }] as const;
const ENCODED_PAYLOAD_BYTES = 64;

export interface PlainWithdrawalPayload {
  recipient: EthAddress;
  relayerTip: bigint;
}

export interface PlainRelayerPayload {
  tipRecipient: EthAddress;
  withdrawalSubsidy: EthAddress;
}

export function encodePlainWithdrawalPayload(payload: PlainWithdrawalPayload): Buffer {
  assertPlainWithdrawalRecipient(payload.recipient);
  return Buffer.from(
    encodeAbiParameters(USER_PAYLOAD_PARAMETERS, [payload.recipient.toString() as Hex, payload.relayerTip]).slice(2),
    'hex',
  );
}

export function decodePlainWithdrawalPayload(payload: Buffer): PlainWithdrawalPayload {
  assertPayloadLength(payload, 'Plain withdrawal user');
  assertCanonicalAddressWord(payload, 0, 'Plain withdrawal recipient');
  const [recipient, relayerTip] = decodeAbiParameters(USER_PAYLOAD_PARAMETERS, `0x${payload.toString('hex')}`);
  const ethRecipient = EthAddress.fromString(recipient);
  assertPlainWithdrawalRecipient(ethRecipient);
  return { recipient: ethRecipient, relayerTip };
}

export function encodePlainRelayerPayload(payload: PlainRelayerPayload): Buffer {
  return Buffer.from(
    encodeAbiParameters(RELAYER_PAYLOAD_PARAMETERS, [
      payload.tipRecipient.toString() as Hex,
      payload.withdrawalSubsidy.toString() as Hex,
    ]).slice(2),
    'hex',
  );
}

export function decodePlainRelayerPayload(payload: Buffer): PlainRelayerPayload {
  assertPayloadLength(payload, 'Plain withdrawal relayer');
  assertCanonicalAddressWord(payload, 0, 'Plain withdrawal tip recipient');
  assertCanonicalAddressWord(payload, 32, 'Plain withdrawal subsidy');
  const [tipRecipient, withdrawalSubsidy] = decodeAbiParameters(
    RELAYER_PAYLOAD_PARAMETERS,
    `0x${payload.toString('hex')}`,
  );
  return {
    tipRecipient: EthAddress.fromString(tipRecipient),
    withdrawalSubsidy: EthAddress.fromString(withdrawalSubsidy),
  };
}

export function assertPlainWithdrawalTip(
  amount: bigint,
  proverTip: bigint,
  relayerTip: bigint,
  fpcFundingCut: bigint,
  frozen: boolean,
): void {
  if (proverTip > amount) {
    throw new Error('Withdrawal prover tip exceeds the withdrawal amount.');
  }
  const executorAmount = plainWithdrawalExecutorAmount(amount, proverTip, fpcFundingCut, frozen);
  if (relayerTip > executorAmount) {
    throw new Error(`Plain withdrawal relayer tip ${relayerTip} exceeds executor amount ${executorAmount}.`);
  }
}

/** The DAI the portal pays the executor: the amount less the prover tip and the FPC funding cut. */
export function plainWithdrawalExecutorAmount(
  amount: bigint,
  proverTip: bigint,
  fpcFundingCut: bigint,
  frozen: boolean,
): bigint {
  const beforeCut = amount - proverTip;
  return frozen ? beforeCut : beforeCut - (fpcFundingCut < beforeCut ? fpcFundingCut : beforeCut);
}

function assertPayloadLength(payload: Buffer, label: string): void {
  if (payload.length !== ENCODED_PAYLOAD_BYTES) {
    throw new Error(`${label} payload must contain exactly ${ENCODED_PAYLOAD_BYTES} bytes.`);
  }
}

function assertCanonicalAddressWord(payload: Buffer, offset: number, label: string): void {
  if (payload.subarray(offset, offset + 12).some(byte => byte !== 0)) {
    throw new Error(`${label} address has non-zero padding.`);
  }
}

function assertPlainWithdrawalRecipient(recipient: EthAddress): void {
  if (recipient.equals(EthAddress.ZERO)) {
    throw new Error('Plain withdrawal recipient must not be zero.');
  }
}

/** Executor the portal hands a verified refund to, plus the payloads it runs. */
export interface PlainExecutorCall {
  executor: EthAddress;
  userPayload: Buffer;
  relayerPayload: Buffer;
}

/**
 * Build the executor call that routes a refund through the canonical plain withdrawal executor: the
 * executor pays `relayerTip` to the relayer-named `tipRecipient` and the remainder to `recipient`.
 */
export function buildPlainExecutorCall(args: {
  executor: EthAddress;
  recipient: EthAddress;
  relayerTip?: bigint;
  tipRecipient?: EthAddress;
  withdrawalSubsidy?: EthAddress;
}): PlainExecutorCall {
  const relayerTip = args.relayerTip ?? 0n;
  const userPayload = encodePlainWithdrawalPayload({ recipient: args.recipient, relayerTip });
  const relayerPayload = encodePlainRelayerPayload({
    tipRecipient: args.tipRecipient ?? EthAddress.ZERO,
    withdrawalSubsidy: args.withdrawalSubsidy ?? EthAddress.ZERO,
  });
  return { executor: args.executor, userPayload, relayerPayload };
}
