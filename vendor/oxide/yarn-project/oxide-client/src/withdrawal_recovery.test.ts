import { Fr } from '@aztec-labs/aztec.js/fields';
import type { PrivateEvent, Wallet } from '@aztec-labs/aztec.js/wallet';
import { PRIVATE_LOG_SIZE_IN_FIELDS } from '@aztec-labs/constants';
import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHash } from '@aztec-labs/stdlib/block';
import { PrivateLog, SiloedTag, Tag } from '@aztec-labs/stdlib/logs';
import { TxEffect, TxHash } from '@aztec-labs/stdlib/tx';

import { OxideTokenContract } from '@oxide/noir-contracts.js/OxideToken';
import { computeWithdrawMessageHash } from '@oxide/oxide-lib/hash.js';
import { TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG } from '@oxide/oxide-lib/oxide_constants.gen.js';
import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal_executor.js';
import type { PortalDomain } from '@oxide/oxide-lib/types.js';
import { type WithdrawalFinalizationData, toOutboxWithdrawal } from '@oxide/oxide-lib/withdrawal_finalization_data.js';
import { chunkRecoveryData } from '@oxide/oxide-lib/withdrawal_recovery_data.js';

import { beforeAll, describe, expect, it } from '@jest/globals';

import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';
import { verifyWithdrawalInTx } from './withdrawal_in_tx.js';
import { recoverWithdrawals } from './withdrawal_recovery.js';

const recoveryEventMetadata = OxideTokenContract.events.WithdrawalRecoveryChunk;
let portal: PortalDomain;
let owner: AztecAddress;

beforeAll(async () => {
  portal = {
    l1Portal: EthAddress.random(),
    l1ChainId: 31337n,
    l2Token: await AztecAddress.random(),
    teeRegistry: EthAddress.random(),
    rollupVersion: 7n,
  };
  owner = await AztecAddress.random();
});

function finalizationData(randomness: bigint, userPayload?: Buffer): WithdrawalFinalizationData {
  return {
    executor: EthAddress.fromString('0x1111111111111111111111111111111111111111'),
    amount: 1000n,
    proverTip: 10n,
    randomness: new Fr(randomness),
    withdrawalSignature: { rHi: new Fr(1n), rLo: new Fr(2n), sHi: new Fr(3n), sLo: new Fr(4n) },
    userPayload: userPayload ?? encodePlainWithdrawalPayload({ recipient: EthAddress.fromNumber(5), relayerTip: 3n }),
  };
}

/** A tx effect that attests and sends the given withdrawals. */
async function effectFor(withdrawals: WithdrawalFinalizationData[]): Promise<TxEffect> {
  const hashes = withdrawals.map(w => computeWithdrawMessageHash(portal, toOutboxWithdrawal(w)));
  const fields = Array.from({ length: PRIVATE_LOG_SIZE_IN_FIELDS }, () => Fr.ZERO);
  fields[0] = (
    await SiloedTag.computeFromTagAndApp(new Tag(new Fr(TEE_WITHDRAWAL_MESSAGE_HASHES_DA_TAG)), portal.l2Token)
  ).value;
  hashes.forEach((hash, i) => (fields[i + 1] = hash));
  const effect = TxEffect.empty();
  effect.privateLogs = [new PrivateLog(fields as PrivateLog['fields'], hashes.length + 1)];
  effect.l2ToL1Msgs = [Fr.random(), ...hashes];
  return effect;
}

function eventsFor(txHash: TxHash, withdrawals: WithdrawalFinalizationData[], memos: Buffer[] = []) {
  const events = [];
  for (const [k, w] of withdrawals.entries()) {
    for (const chunk of chunkRecoveryData({ finalizationData: w, memo: memos[k] ?? Buffer.alloc(0) })) {
      events.push({
        event: { fields: chunk.map(f => f.toBigInt()) },
        metadata: { txHash, l2BlockNumber: BlockNumber(1), l2BlockHash: BlockHash.ZERO },
      });
    }
  }
  return events;
}

function walletWith(events: ReturnType<typeof eventsFor>): Pick<Wallet, 'getPrivateEvents'> {
  return { getPrivateEvents: <T>() => Promise.resolve(events as PrivateEvent<T>[]) };
}

function chainWith(effects: Map<string, TxEffect>): Pick<ChainDataSource, 'getTxEffect'> {
  return {
    getTxEffect: (txHash: TxHash) =>
      Promise.resolve(
        effects.has(txHash.toString())
          ? {
              data: effects.get(txHash.toString())!,
              l2BlockNumber: BlockNumber(1),
              l2BlockHash: BlockHash.ZERO,
              txIndexInBlock: 0,
              slotNumber: SlotNumber(1),
            }
          : undefined,
      ),
  };
}

describe('recoverWithdrawals', () => {
  it('reassembles withdrawals per tx, including overflow and identical payloads with distinct randomness', async () => {
    const txA = TxHash.random();
    const txB = TxHash.random();
    const big = Buffer.alloc(900, 7);
    const withdrawalsA = [finalizationData(1n, big), finalizationData(2n), finalizationData(3n, big)];
    const withdrawalsB = [finalizationData(4n)];
    const effects = new Map([
      [txA.toString(), await effectFor(withdrawalsA)],
      [txB.toString(), await effectFor(withdrawalsB)],
    ]);
    const events = [...eventsFor(txA, withdrawalsA), ...eventsFor(txB, withdrawalsB)];
    const wallet = walletWith(events);

    const { withdrawals, failures } = await recoverWithdrawals({
      wallet,
      chain: chainWith(effects),
      portal,
      owner,
      recoveryEventMetadata,
    });

    expect(failures).toEqual([]);
    expect(withdrawals.map(w => [w.txHash.toString(), w.withdrawalIndex])).toEqual([
      [txA.toString(), 0],
      [txA.toString(), 1],
      [txA.toString(), 2],
      [txB.toString(), 0],
    ]);
    expect(withdrawals[0].finalizationData.userPayload.equals(big)).toBe(true);
    expect(withdrawals[2].finalizationData.randomness.equals(new Fr(3n))).toBe(true);
  });

  it('returns the memo of each withdrawal', async () => {
    const txHash = TxHash.random();
    const sent = [finalizationData(1n), finalizationData(2n), finalizationData(3n)];
    const memos = [Buffer.alloc(400, 1), Buffer.alloc(0), Buffer.from('escrow args')];
    const chain = chainWith(new Map([[txHash.toString(), await effectFor(sent)]]));
    const wallet = walletWith(eventsFor(txHash, sent, memos));
    const { withdrawals, failures } = await recoverWithdrawals({ wallet, chain, portal, owner, recoveryEventMetadata });
    expect(failures).toEqual([]);
    expect(withdrawals.map(w => w.withdrawalIndex)).toEqual([0, 1, 2]);
    expect(withdrawals.map(w => w.memo)).toEqual(memos);
  });

  it('recovers a nonzero index when another owner holds the first withdrawal', async () => {
    const txHash = TxHash.random();
    const sent = [finalizationData(1n), finalizationData(2n)];
    const chain = chainWith(new Map([[txHash.toString(), await effectFor(sent)]]));
    const wallet = walletWith(eventsFor(txHash, sent).slice(1));
    const { withdrawals, failures } = await recoverWithdrawals({ wallet, chain, portal, owner, recoveryEventMetadata });
    expect(failures).toEqual([]);
    expect(withdrawals.map(w => w.withdrawalIndex)).toEqual([1]);
  });

  it('recovers a withdrawal with repeated recovery data once', async () => {
    const txHash = TxHash.random();
    const sent = [finalizationData(1n)];
    const chain = chainWith(new Map([[txHash.toString(), await effectFor(sent)]]));
    const wallet = walletWith(eventsFor(txHash, [sent[0], sent[0]]));
    const { withdrawals, failures } = await recoverWithdrawals({ wallet, chain, portal, owner, recoveryEventMetadata });
    expect(failures).toEqual([]);
    expect(withdrawals.map(w => w.withdrawalIndex)).toEqual([0]);
  });

  it('reports a tx whose withdrawals do not match its effects, and keeps the others', async () => {
    const good = TxHash.random();
    const bad = TxHash.random();
    const effects = new Map([
      [good.toString(), await effectFor([finalizationData(1n)])],
      // The bad tx attests a different withdrawal.
      [bad.toString(), await effectFor([finalizationData(99n)])],
    ]);
    const events = [...eventsFor(good, [finalizationData(1n)]), ...eventsFor(bad, [finalizationData(2n)])];
    const wallet = walletWith(events);

    const { withdrawals, failures } = await recoverWithdrawals({
      wallet,
      chain: chainWith(effects),
      portal,
      owner,
      recoveryEventMetadata,
    });

    expect(withdrawals).toHaveLength(1);
    expect(failures.map(f => f.txHash.toString())).toEqual([bad.toString()]);
  });

  it('reports incomplete recovery data', async () => {
    const txHash = TxHash.random();
    const sent = [finalizationData(1n, Buffer.alloc(900, 7))];
    const effects = new Map([[txHash.toString(), await effectFor(sent)]]);
    const events = eventsFor(txHash, sent).slice(0, -1);
    const wallet = walletWith(events);

    const { failures } = await recoverWithdrawals({
      wallet,
      chain: chainWith(effects),
      portal,
      owner,
      recoveryEventMetadata,
    });
    expect(failures[0].reason).toMatch(/beyond buffer length/);
  });
});

describe('verifyWithdrawalInTx', () => {
  it("locates the withdrawal message in the tx's attested withdrawals and L2-to-L1 messages", async () => {
    const sent = [finalizationData(1n), finalizationData(2n)];
    const effect = await effectFor(sent);
    const message = await verifyWithdrawalInTx(
      chainWith(new Map()),
      portal,
      { txHash: TxHash.random(), finalizationData: sent[1] },
      effect,
    );
    expect(message.messageHash.equals(effect.l2ToL1Msgs[2])).toBe(true);
    expect(message.withdrawalIndex).toBe(1);
    expect(message.messageIndexInTx).toBe(2);
  });

  it('rejects a withdrawal the tx did not attest', async () => {
    const effect = await effectFor([finalizationData(1n)]);
    await expect(
      verifyWithdrawalInTx(
        chainWith(new Map()),
        portal,
        { txHash: TxHash.random(), finalizationData: finalizationData(2n) },
        effect,
      ),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('rejects a message the tx did not send', async () => {
    const sent = [finalizationData(1n)];
    const effect = await effectFor(sent);
    effect.l2ToL1Msgs = [];
    await expect(
      verifyWithdrawalInTx(
        chainWith(new Map()),
        portal,
        { txHash: TxHash.random(), finalizationData: sent[0] },
        effect,
      ),
    ).rejects.toThrow(/no L2-to-L1 message/);
  });
});
