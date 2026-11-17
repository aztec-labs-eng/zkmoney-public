import type { Hex } from 'viem';

/** Days to keep behind the current day before pruning stale nonce counters. */
export const EXPIRATION_TIME_DAYS = 1;

/**
 * The per-(user, day) nonce counters of the gateway. Backed by LMDB (single-process dev/e2e) or Postgres (prod, shared
 * by the gateway fleet) — see {@link LmdbResolverStore} / {@link PgResolverStore}.
 */
export interface ResolverStore {
  /** Allocates the next nonce for `(userIdentifier, day)`, starting at 0. */
  nextNonce(userIdentifier: Hex, day: number): Promise<number>;

  /** Drops nonce counters from days outside the retention window. Returns the number dropped. */
  pruneNonces(currentDay: number): Promise<number>;

  close(): Promise<void>;
}
