import type { IStorageAdapter } from "../../storages/adapter"
import { RecordStorage } from "../bridge/RecordStorage"
import type { SavingsMoveRecord } from "./types"

const KEY_SAVINGS_MOVES = "@obsidion/savings/moves"

/** The moves this front made, keyed by their burn's withdrawal record. Strict: a move must be durable before it is acted on. */
export class SavingsMoveStorage extends RecordStorage<SavingsMoveRecord> {
  constructor(storage: IStorageAdapter) {
    super({
      storage,
      storageKey: KEY_SAVINGS_MOVES,
      keyOf: (record) => record.withdrawalLocalId,
      sortBy: (record) => record.startTime,
      label: "SavingsMoveStorage",
      strict: true,
    })
  }

  get(withdrawalLocalId: string): SavingsMoveRecord | null {
    return this.getByKey(withdrawalLocalId)
  }

  put(record: SavingsMoveRecord): Promise<SavingsMoveRecord> {
    return this.setRecord(record.withdrawalLocalId, record)
  }

  /** Drops a move whose burn never went out. */
  remove(withdrawalLocalId: string): Promise<void> {
    return this.removeByKey(withdrawalLocalId)
  }
}
