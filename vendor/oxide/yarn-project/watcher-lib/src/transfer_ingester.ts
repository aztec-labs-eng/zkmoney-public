import { EthAddress } from '@aztec/foundation/eth-address';
import type { Logger } from '@aztec/foundation/log';
import { createLogger } from '@aztec/foundation/log';

import type { Hex, PublicClient } from 'viem';
import { parseAbiItem } from 'viem';

import { scanWindows } from './log_scan.js';
import { type CursorStore, ReorgSafeCursor } from './reorg_cursor.js';

const ERC20_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export interface TransferEvent {
  token: EthAddress;
  sender: EthAddress;
  recipient: EthAddress;
  value: bigint;
  block: bigint;
  txHash: Hex;
  logIndex: number;
}

export interface TransferIngesterOptions {
  publicClient: PublicClient;
  cursorStore: CursorStore;
  /** ERC20s whose Transfer events are ingested, unfiltered by recipient. */
  tokens: EthAddress[];
  /** Max blocks per `eth_getLogs` call; one call covers every token, and a capped window is retried at half its span. */
  window: bigint;
  maxReorgDepth?: bigint;
  /** Fail on a missing cursor instead of starting near the tip; for cursors seeded explicitly before the first poll. */
  requireCursor?: boolean;
  log?: Logger;
  /** Called once per non-empty scanned window with every token's events in it, sorted by (block, logIndex). */
  onEvents: (events: TransferEvent[]) => Promise<void>;
  /** Called with the rewind target block when a reorg is detected, before rescanning resumes. */
  onReorg?: (from: bigint) => Promise<void>;
}

/**
 * Scans every Transfer event for `tokens`, unfiltered by recipient, and hands each window's events to `onEvents`
 */
export class TransferIngester {
  private readonly cursor: ReorgSafeCursor;

  constructor(private readonly options: TransferIngesterOptions) {
    this.cursor = new ReorgSafeCursor({
      store: options.cursorStore,
      publicClient: options.publicClient,
      // TODO(benesjan): there will be a lot of relayers. Does it really make sense to bother with reorgs given that
      // txs tend to be quickly reincluded?
      maxReorgDepth: options.maxReorgDepth,
      requireCursor: options.requireCursor,
      log: options.log ?? createLogger('watcher-lib:transfer-ingester'),
    });
  }

  /**
   * Ingests Transfers up to `chainTip` and advances the cursor once the full range has been scanned. A failure
   * leaves the cursor untouched, so the next call rescans the whole range from the previous tip.
   */
  async ingestUpTo(chainTip: bigint, chainTipHash: Hex): Promise<void> {
    const { from, rewound } = await this.cursor.getScanFrom(chainTip);
    if (rewound) {
      await this.options.onReorg?.(from);
    }

    if (from <= chainTip) {
      const range = { fromBlock: from, toBlock: chainTip, window: this.options.window };
      for await (const { logs: events } of scanWindows(range, (fromBlock, toBlock) =>
        this.#fetch(fromBlock, toBlock),
      )) {
        if (events.length > 0) {
          events.sort((a, b) => (a.block !== b.block ? Number(a.block - b.block) : a.logIndex - b.logIndex));
          await this.options.onEvents(events);
        }
      }
    }

    await this.cursor.advance(chainTip, chainTipHash);
  }

  async #fetch(fromBlock: bigint, toBlock: bigint): Promise<TransferEvent[]> {
    if (this.options.tokens.length === 0) {
      return [];
    }
    const logs = await this.options.publicClient.getLogs({
      address: this.options.tokens.map(token => token.toString()),
      event: ERC20_TRANSFER_EVENT,
      fromBlock,
      toBlock,
      strict: true,
    });
    return logs
      .filter(l => l.transactionHash !== null && l.blockNumber !== null && l.logIndex !== null)
      .map(l => ({
        token: EthAddress.fromString(l.address),
        sender: EthAddress.fromString(l.args.from),
        recipient: EthAddress.fromString(l.args.to),
        value: l.args.value,
        block: l.blockNumber!,
        txHash: l.transactionHash!,
        logIndex: l.logIndex!,
      }));
  }
}
