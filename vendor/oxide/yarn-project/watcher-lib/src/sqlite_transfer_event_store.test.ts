import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';
import type { Hex } from 'viem';

import { MAX_CANDIDATES_PER_QUERY, SqliteTransferEventStore } from './sqlite_transfer_event_store.js';
import type { TransferEvent } from './transfer_ingester.js';

const TOKEN_A = EthAddress.fromString('0x000000000000000000000000000000000000aaaa');
const TOKEN_B = EthAddress.fromString('0x000000000000000000000000000000000000bbbb');
const RECIPIENT_A = EthAddress.fromString('0x0000000000000000000000000000000000000001');
const RECIPIENT_B = EthAddress.fromString('0x0000000000000000000000000000000000000002');
const SENDER_A = EthAddress.fromString('0x0000000000000000000000000000000000000003');
const SENDER_B = EthAddress.fromString('0x0000000000000000000000000000000000000004');

/** A distinct, deterministic address for index `i`, used to build large candidate lists. */
function addressAt(i: number): EthAddress {
  return EthAddress.fromString(`0x${i.toString(16).padStart(40, '0')}`);
}

function event(override: Partial<TransferEvent> = {}): TransferEvent {
  return {
    token: TOKEN_A,
    recipient: RECIPIENT_A,
    sender: SENDER_A,
    value: 1n,
    block: 1n,
    txHash: `0x${'ab'.repeat(32)}` as Hex,
    logIndex: 0,
    ...override,
  };
}

async function withStoreFile(fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watcher-lib-transfer-store-'));
  try {
    await fn(path.join(dir, 'transfers.sqlite3'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withStore(fn: (store: SqliteTransferEventStore) => Promise<void>): Promise<void> {
  await withStoreFile(async file => {
    const store = await SqliteTransferEventStore.open(file);
    try {
      await fn(store);
    } finally {
      await store.close();
    }
  });
}

describe('SqliteTransferEventStore', () => {
  it('finds a recipient among candidates after insert', async () => {
    await withStore(async store => {
      await store.insert([event({ recipient: RECIPIENT_A })]);

      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A, RECIPIENT_B])).resolves.toEqual([RECIPIENT_A]);
    });
  });

  it('does not treat a zero-value transfer as funding', async () => {
    await withStore(async store => {
      await store.insert([event({ value: 0n })]);

      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A])).resolves.toEqual([]);
    });
  });

  it('finds positive-value funders for selected tokens once', async () => {
    await withStore(async store => {
      await store.insert([
        event({ sender: SENDER_A, txHash: `0x${'aa'.repeat(32)}` as Hex }),
        event({ sender: SENDER_A, txHash: `0x${'bb'.repeat(32)}` as Hex }),
        event({ sender: SENDER_B, value: 0n, txHash: `0x${'cc'.repeat(32)}` as Hex }),
        event({ sender: SENDER_B, recipient: RECIPIENT_B, txHash: `0x${'dd'.repeat(32)}` as Hex }),
        event({ sender: SENDER_B, token: TOKEN_B, txHash: `0x${'ee'.repeat(32)}` as Hex }),
      ]);

      await expect(store.findFunders([TOKEN_A], RECIPIENT_A)).resolves.toEqual([SENDER_A]);
      await expect(store.findFunders([TOKEN_A], RECIPIENT_B)).resolves.toEqual([SENDER_B]);
      await expect(store.findFunders([], RECIPIENT_A)).resolves.toEqual([]);
    });
  });

  it('drops a table written by an older schema version rather than reusing it', async () => {
    await withStoreFile(async file => {
      // eslint-disable-next-line import-x/no-named-as-default-member
      const legacy = await open({ filename: file, driver: sqlite3Driver.Database });
      await legacy.exec(`
        CREATE TABLE l1_transfer_events (
          tx_hash TEXT NOT NULL,
          log_index INTEGER NOT NULL,
          token TEXT NOT NULL,
          recipient TEXT NOT NULL,
          value TEXT NOT NULL,
          block_number TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          PRIMARY KEY (tx_hash, log_index)
        );
        INSERT INTO l1_transfer_events
          VALUES ('0xold', 0, '${TOKEN_A.toString()}', '${RECIPIENT_A.toString()}', '1', '1', '2026-01-01T00:00:00.000Z');
      `);
      await legacy.close();

      const store = await SqliteTransferEventStore.open(file);
      try {
        await store.insert([event()]);
        await expect(store.findFunders([TOKEN_A], RECIPIENT_A)).resolves.toEqual([SENDER_A]);
      } finally {
        await store.close();
      }
    });
  });

  it('keeps stored rows when it reopens a file at the current schema version', async () => {
    await withStoreFile(async file => {
      const first = await SqliteTransferEventStore.open(file);
      await first.insert([event()]);
      await first.close();

      const second = await SqliteTransferEventStore.open(file);
      try {
        await expect(second.findFunders([TOKEN_A], RECIPIENT_A)).resolves.toEqual([SENDER_A]);
      } finally {
        await second.close();
      }
    });
  });

  it('does not match a candidate that never received a transfer', async () => {
    await withStore(async store => {
      await store.insert([event({ recipient: RECIPIENT_A })]);

      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_B])).resolves.toEqual([]);
    });
  });

  it('does not match a transfer of an unlisted token', async () => {
    await withStore(async store => {
      await store.insert([event({ token: TOKEN_B, recipient: RECIPIENT_A })]);

      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A])).resolves.toEqual([]);
    });
  });

  it('returns no results for an empty token or candidate list', async () => {
    await withStore(async store => {
      await store.insert([event()]);

      await expect(store.findRecipients([], [RECIPIENT_A])).resolves.toEqual([]);
      await expect(store.findRecipients([TOKEN_A], [])).resolves.toEqual([]);
    });
  });

  it('is idempotent on repeated insert of the same (txHash, logIndex)', async () => {
    await withStore(async store => {
      await store.insert([event()]);
      await store.insert([event()]);

      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A])).resolves.toEqual([RECIPIENT_A]);
    });
  });

  it('commits a multi-event batch in one call', async () => {
    await withStore(async store => {
      await store.insert([
        event({ recipient: RECIPIENT_A, txHash: `0x${'aa'.repeat(32)}` as Hex, logIndex: 0 }),
        event({ recipient: RECIPIENT_B, txHash: `0x${'bb'.repeat(32)}` as Hex, logIndex: 0 }),
        event({ recipient: RECIPIENT_A, txHash: `0x${'cc'.repeat(32)}` as Hex, logIndex: 0 }),
      ]);

      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A, RECIPIENT_B])).resolves.toEqual(
        expect.arrayContaining([RECIPIENT_A, RECIPIENT_B]),
      );
    });
  });

  it('is a no-op for an empty batch', async () => {
    await withStore(async store => {
      await expect(store.insert([])).resolves.toBeUndefined();
      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A])).resolves.toEqual([]);
    });
  });

  it('deleteFromBlock purges rows at or above the given block but keeps earlier ones', async () => {
    await withStore(async store => {
      await store.insert([
        event({ recipient: RECIPIENT_A, block: 10n, txHash: `0x${'aa'.repeat(32)}` as Hex, logIndex: 0 }),
        event({ recipient: RECIPIENT_B, block: 20n, txHash: `0x${'bb'.repeat(32)}` as Hex, logIndex: 0 }),
      ]);

      await store.deleteFromBlock(20n);

      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A, RECIPIENT_B])).resolves.toEqual([RECIPIENT_A]);
    });
  });

  it('matches candidates spanning more than one query chunk', async () => {
    await withStore(async store => {
      // One match in the first chunk, one right at the boundary of the next — exercises the chunking loop itself,
      // not just a single query under the limit.
      const matchedFirstChunk = addressAt(0);
      const matchedSecondChunk = addressAt(MAX_CANDIDATES_PER_QUERY);
      await store.insert([
        event({ recipient: matchedFirstChunk, txHash: `0x${'aa'.repeat(32)}` as Hex, logIndex: 0 }),
        event({ recipient: matchedSecondChunk, txHash: `0x${'bb'.repeat(32)}` as Hex, logIndex: 0 }),
      ]);

      const candidates = Array.from({ length: MAX_CANDIDATES_PER_QUERY + 1 }, (_, i) => addressAt(i));
      const found = await store.findRecipients([TOKEN_A], candidates);

      expect(new Set(found)).toEqual(new Set([matchedFirstChunk, matchedSecondChunk]));
    });
  });

  it('pruneObservedBefore drops old rows and reports how many were dropped', async () => {
    await withStore(async store => {
      await store.insert([event()]);

      const droppedNow = await store.pruneObservedBefore(new Date(Date.now() - 1000));
      expect(droppedNow).toBe(0);

      const dropped = await store.pruneObservedBefore(new Date(Date.now() + 1000));
      expect(dropped).toBe(1);
      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_A])).resolves.toEqual([]);
    });
  });

  it('pruneObservedBefore keeps rows whose recipient is in the keep list', async () => {
    await withStore(async store => {
      await store.insert([event(), event({ recipient: RECIPIENT_B, logIndex: 1 })]);

      const dropped = await store.pruneObservedBefore(new Date(Date.now() + 1000), [RECIPIENT_A]);

      expect(dropped).toBe(1);
      await expect(store.findFunders([TOKEN_A], RECIPIENT_A)).resolves.toEqual([SENDER_A]);
      await expect(store.findRecipients([TOKEN_A], [RECIPIENT_B])).resolves.toEqual([]);
    });
  });
});
