import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';

import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it, jest } from '@jest/globals';
import { type Hex, type Log, pad, toEventSelector } from 'viem';

import type { PendingL1Operation } from '../state/types.js';
import { L1OperationScreener } from './l1_operation_screener.js';

const TARGET = EthAddress.random();
const PAYOUT_TOKEN = EthAddress.random();
const FROM = EthAddress.random();
const TO = EthAddress.random();
const EMITTER = EthAddress.random();
/** The pseudo-token `eth_simulateV1` emits synthetic ETH `Transfer` logs from, as the RPC spells it. */
const ETH_PSEUDO_TOKEN = `0x${'ee'.repeat(20)}` as Hex;

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const APPROVAL = toEventSelector('Approval(address,address,uint256)');

const OPERATION: PendingL1Operation = {
  operationId: `0x${'ab'.repeat(32)}`,
  broadcaster: AztecAddress.fromBigIntUnsafe(7n),
  l2TxHash: '0xl2tx',
  l2BlockNumber: 5n,
  target: TARGET,
  payoutToken: PAYOUT_TOKEN,
  calldata: Buffer.from('deadbeef', 'hex'),
  condition: L1OperationCondition.immediate(),
  status: 'pending',
  attempts: 0,
  createdAt: new Date(),
};

function topic(address: EthAddress): Hex {
  return pad(address.toString() as Hex, { size: 32 });
}

function log(address: EthAddress | Hex, topics: Hex[]): Log {
  return {
    address: typeof address === 'string' ? address : (address.toString() as Hex),
    topics,
    data: '0x',
  } as unknown as Log;
}

function keys(addresses: EthAddress[]): string[] {
  return addresses.map(address => address.toString().toLowerCase());
}

/** Lists every address, so `screen` returns the full set the operation and logs expose. */
const listAll = { isListed: (_address: EthAddress) => true };
const collectScreenedAddresses = (operation: PendingL1Operation, logs: Log[]) =>
  new L1OperationScreener(listAll).screen(operation, logs);

describe('L1OperationScreener.screen collects', () => {
  it('always includes the target and the payout token', async () => {
    expect(keys(await collectScreenedAddresses(OPERATION, []))).toEqual(keys([TARGET, PAYOUT_TOKEN]));
  });

  it('collects both parties of an ERC-20 Transfer and its emitter', async () => {
    const logs = [log(EMITTER, [TRANSFER, topic(FROM), topic(TO)])];
    expect(keys(await collectScreenedAddresses(OPERATION, logs))).toEqual(
      keys([TARGET, PAYOUT_TOKEN, EMITTER, FROM, TO]),
    );
  });

  it('collects the parties of the synthetic ETH transfer log traceTransfers emits', async () => {
    const logs = [log(ETH_PSEUDO_TOKEN, [TRANSFER, topic(FROM), topic(TO)])];
    expect(keys(await collectScreenedAddresses(OPERATION, logs))).toEqual([
      ...keys([TARGET, PAYOUT_TOKEN]),
      ETH_PSEUDO_TOKEN.toLowerCase(),
      ...keys([FROM, TO]),
    ]);
  });

  it('collects only the emitter of an unrelated event', async () => {
    const logs = [log(EMITTER, [APPROVAL, topic(FROM), topic(TO)])];
    expect(keys(await collectScreenedAddresses(OPERATION, logs))).toEqual(keys([TARGET, PAYOUT_TOKEN, EMITTER]));
  });

  it('ignores the topics of a Transfer log whose topic count is not the ERC-20 one', async () => {
    const tokenId = pad('0x2a', { size: 32 });
    const logs = [log(EMITTER, [TRANSFER, topic(FROM)]), log(EMITTER, [TRANSFER, topic(FROM), topic(TO), tokenId])];
    expect(keys(await collectScreenedAddresses(OPERATION, logs))).toEqual(keys([TARGET, PAYOUT_TOKEN, EMITTER]));
  });

  it('deduplicates addresses across the tuple and the logs', async () => {
    const logs = [
      log(PAYOUT_TOKEN, [TRANSFER, topic(TARGET), topic(TO)]),
      log(PAYOUT_TOKEN, [TRANSFER, topic(TO), topic(TARGET)]),
    ];
    expect(keys(await collectScreenedAddresses(OPERATION, logs))).toEqual(keys([TARGET, PAYOUT_TOKEN, TO]));
  });
});

describe('L1OperationScreener', () => {
  const listOf = (...listed: EthAddress[]) => ({
    isListed: (address: EthAddress) => listed.some(entry => entry.equals(address)),
  });

  it('returns the SDN hits in order of first sight', async () => {
    const screener = new L1OperationScreener(listOf(TO, TARGET));
    const listed = await screener.screen(OPERATION, [log(EMITTER, [TRANSFER, topic(FROM), topic(TO)])]);
    expect(keys(listed)).toEqual(keys([TARGET, TO]));
  });

  it('returns the addresses Predicate declines', async () => {
    const isCompliant = jest.fn((address: EthAddress) => Promise.resolve(!address.equals(FROM)));
    const screener = new L1OperationScreener(listOf(), { isCompliant });
    expect(keys(await screener.screen(OPERATION, [log(TARGET, [TRANSFER, topic(FROM), topic(TO)])]))).toEqual(
      keys([FROM]),
    );
    expect(isCompliant).toHaveBeenCalledTimes(4);
  });

  it('does not ask Predicate about an address the SDN list already lists', async () => {
    const isCompliant = jest.fn((_address: EthAddress) => Promise.resolve(true));
    const screener = new L1OperationScreener(listOf(TARGET), { isCompliant });
    expect(keys(await screener.screen(OPERATION, []))).toEqual(keys([TARGET]));
    expect(isCompliant).toHaveBeenCalledTimes(1);
    expect(isCompliant.mock.calls[0][0].equals(PAYOUT_TOKEN)).toBe(true);
  });

  it('propagates a Predicate error', async () => {
    const isCompliant = jest.fn((_address: EthAddress) => Promise.reject(new Error('predicate down')));
    const screener = new L1OperationScreener(listOf(), { isCompliant });
    await expect(screener.screen(OPERATION, [])).rejects.toThrow('predicate down');
  });

  it('skips Predicate when it is not configured', async () => {
    const screener = new L1OperationScreener(listOf());
    expect(await screener.screen(OPERATION, [])).toEqual([]);
  });
});
