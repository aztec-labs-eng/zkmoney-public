import type { IStorageAdapter, StorageLock } from "../storages/adapter"
import {
  advanceMetadataMigration,
  newMetadataMigration,
  type MetadataMigrationRecord,
  type MetadataMigrationSteps,
} from "./metadataMigrationFlow"

/** Durable migration driver. The host supplies storage and the SDK contract adapter. */
export class MetadataMigrationController {
  private running?: Promise<MetadataMigrationRecord | null>
  private listeners = new Set<() => void>()
  private record: MetadataMigrationRecord | null = null

  constructor(
    private readonly storage: Pick<IStorageAdapter, "getItem" | "setItem">,
    private readonly steps: MetadataMigrationSteps,
    private readonly key: string,
    private readonly lock: StorageLock = (fn) => fn(),
  ) {}

  getSnapshot = () => this.record
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(record: MetadataMigrationRecord | null) {
    this.record = record
    this.listeners.forEach((listener) => listener())
  }

  /** Load without opening a signing prompt. Resume remains an explicit user action after launch. */
  async load(): Promise<void> {
    const raw = await this.storage.getItem(this.key)
    this.publish(raw ? (JSON.parse(raw) as MetadataMigrationRecord) : null)
  }

  /** start=true is the user's initial action; subsequent calls reconcile the same saved plan. */
  advance(start = false): Promise<MetadataMigrationRecord | null> {
    if (this.running) return this.running
    const run = this.lock(async () => {
      const raw = await this.storage.getItem(this.key)
      const existing = raw ? (JSON.parse(raw) as MetadataMigrationRecord) : null
      if (!existing && !start) return null
      const record = existing ?? newMetadataMigration(this.key, await this.steps.binding())
      const result = await advanceMetadataMigration(record, this.steps, async (next) => {
        await this.storage.setItem(this.key, JSON.stringify(next))
        this.publish(next)
      })
      this.publish(result)
      return result
    })
    this.running = run.finally(() => {
      this.running = undefined
    })
    return this.running
  }
}
