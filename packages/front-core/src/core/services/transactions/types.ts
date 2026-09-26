/**
 * Read-only handle a coordination-loop owner registers with the lifecycle
 * service. `id` is the kebab-case key used in `getCoordinationState`'s
 * result map. `getRecordByTxHash` returns `null` when the loop has no record
 * for the given hash. Intentionally minimal — keep it read-only.
 */
export interface CoordinationLoopRegistration<TRecord = unknown> {
  id: string
  getRecordByTxHash: (txHash: string) => TRecord | null
}

/** `{ [loopId]: TRecord | null }`; empty when no loops are registered. */
export type CoordinationStateAggregate = Record<string, unknown | null>
