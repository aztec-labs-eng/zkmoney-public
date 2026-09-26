/**
 * The pending record and its TTL constants, declared in `@obsidion/core` and re-exported here so
 * `@obsidion/sdk` consumers keep one import path. The wallet writes records from inside `sendTx`;
 * the store implementation (`InMemoryPendingTxStore` here, the encrypted `PendingTxStore` in
 * front-core) implements `IPendingTxStore` against this shape.
 */

export type { PendingTxRecord } from "@obsidion/core/types"
export { CLOCK_SKEW_MARGIN_MS, MAX_TX_LIFETIME_MS } from "@obsidion/core/constants"
