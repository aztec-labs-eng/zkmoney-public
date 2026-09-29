import type { Logger } from '@aztec/foundation/log';
import { createLogger } from '@aztec/foundation/log';

import type { Hex, PublicClient } from 'viem';

export interface BlockRef {
  block: bigint;
  hash: Hex;
}

/** Persists and reads a watcher's `{block, hash}` scan cursor. Each service backs this with its own store. */
export interface CursorStore {
  get(): Promise<BlockRef | undefined>;
  set(ref: BlockRef): Promise<void>;
}

export interface ReorgSafeCursorOptions {
  store: CursorStore;
  publicClient: PublicClient;
  /**
   * Blocks to rewind on a detected reorg, and the deepest a stale cursor can trail the tip before erroring. Defaults
   * to 64 (2 Ethereum epochs), the shallowest depth Ethereum finalizes at.
   */
  maxReorgDepth?: bigint;
  /**
   * Fail on a missing cursor instead of starting near the tip. For watchers whose cursor is seeded explicitly before
   * the first poll because starting near the tip could silently skip watched history.
   */
  requireCursor?: boolean;
  log?: Logger;
}

export interface ScanFrom {
  /** First block the next scan should cover. */
  from: bigint;
  /** Whether a reorg was detected and the cursor rewound `maxReorgDepth` blocks below its prior position. */
  rewound: boolean;
}

export const DEFAULT_MAX_REORG_DEPTH = 64n;

/**
 * A reorg-safe L1 scan cursor: on every poll it compares the stored block hash against the chain, and on a mismatch
 * rewinds `maxReorgDepth` blocks to rescan the unfinalized range rather than trusting the new chain's shallow history.
 */
export class ReorgSafeCursor {
  private readonly maxReorgDepth: bigint;
  private readonly log: Logger;

  constructor(private readonly options: ReorgSafeCursorOptions) {
    this.maxReorgDepth = options.maxReorgDepth ?? DEFAULT_MAX_REORG_DEPTH;
    this.log = options.log ?? createLogger('watcher-lib:reorg-cursor');
  }

  /** Computes the next scan's `from` block given the current chain tip. */
  async getScanFrom(chainTip: bigint): Promise<ScanFrom> {
    const { store, publicClient } = this.options;
    const cursor = await store.get();
    if (!cursor) {
      if (this.options.requireCursor) {
        throw new Error('scan cursor missing; seed it before the first poll');
      }
      // Fresh cursor: nothing watched predates it, so start near the tip rather than at genesis.
      return { from: chainTip > this.maxReorgDepth ? chainTip - this.maxReorgDepth : 0n, rewound: false };
    }
    const { block: lastScannedBlock, hash: lastScannedHash } = cursor;
    // A tip further behind the cursor than any real reorg means a stale or broken RPC node. Fail so the cursor
    // survives instead of being rewound to (and then overwritten with) that tip.
    if (chainTip + this.maxReorgDepth < lastScannedBlock) {
      throw new Error(
        `chain tip ${chainTip} is over ${this.maxReorgDepth} blocks behind the scan cursor ${lastScannedBlock}`,
      );
    }
    const reorged =
      lastScannedBlock > chainTip ||
      (await publicClient.getBlock({ blockNumber: lastScannedBlock })).hash !== lastScannedHash;
    if (!reorged) {
      return { from: lastScannedBlock + 1n, rewound: false };
    }

    const rewound = lastScannedBlock > this.maxReorgDepth ? lastScannedBlock - this.maxReorgDepth : 0n;
    this.log.warn(`L1 reorg: rewound scan cursor ${lastScannedBlock} -> ${rewound}`);
    return { from: rewound + 1n, rewound: true };
  }

  /** Persists the cursor once a scan up to `block` has completed. */
  advance(block: bigint, hash: Hex): Promise<void> {
    return this.options.store.set({ block, hash });
  }
}
