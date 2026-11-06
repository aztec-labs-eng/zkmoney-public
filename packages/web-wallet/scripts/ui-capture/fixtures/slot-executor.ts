import * as actual from "../../../src/features/broadcasts/slotExecutor"
import { fixtureState } from "./control"
export * from "../../../src/features/broadcasts/slotExecutor"

// Captures read no chain and publish nothing: every address reads as landed.
export const slotExecutor: typeof actual.slotExecutor = (wallet) =>
  fixtureState()
    ? { landed: async () => true, send: async () => "0x" }
    : actual.slotExecutor(wallet)

export const broadcastTxHashes: typeof actual.broadcastTxHashes = (...args) =>
  fixtureState() ? Promise.resolve(new Set<string>()) : actual.broadcastTxHashes(...args)
