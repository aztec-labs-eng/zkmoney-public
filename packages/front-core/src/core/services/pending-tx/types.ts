/**
 * front-core pending-tx types — re-exports the boundary type and TTL constants from `@obsidion/core`
 * (the same declarations `@obsidion/sdk` re-exports) and adds the storage key.
 */

export type { PendingTxRecord } from "@obsidion/core/types"

/** Both stores (sdk in-memory + this encrypted one) share these so behavior is identical. */
export { CLOCK_SKEW_MARGIN_MS, MAX_TX_LIFETIME_MS } from "@obsidion/core/constants"

/** Storage key for the encrypted record blob (single-key JSON dictionary). */
export const KEY_PENDING = "@obsidion/pending-tx/records"
