import type { MigrationFundingBatch } from "@obsidion/core/types"
import type { IStorageAdapter } from "../storages/adapter"

/** Access is serialized by the owning MetadataMigrationController's account-scoped lock. */
export class MigrationFundingStore {
  constructor(
    private readonly storage: Pick<IStorageAdapter, "getItem" | "setItem">,
    private readonly prefix: string,
  ) {}

  async get(id: string): Promise<MigrationFundingBatch | undefined> {
    const raw = await this.storage.getItem(`${this.prefix}/${id}`)
    return raw ? (JSON.parse(raw) as MigrationFundingBatch) : undefined
  }

  async set(id: string, batch: MigrationFundingBatch): Promise<void> {
    await this.storage.setItem(`${this.prefix}/${id}`, JSON.stringify(batch))
  }
}
