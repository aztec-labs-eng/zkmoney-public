import type { IStorageAdapter, StorageLock } from "../storages/adapter"
import {
  advanceMetadataMigration,
  newMetadataMigration,
  type MetadataMigrationRecord,
  type MetadataMigrationSteps,
  type MetadataMigrationSummary,
} from "./metadataMigrationFlow"
import type { ApprovalGate } from "./savedApprovals"

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
    private readonly gate?: ApprovalGate,
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

  /**
   * start=true is the user's initial action; subsequent calls reconcile the same saved plan.
   * `observeOnly` never prepares, signs or sends, and `promptless` never prepares, signs or
   * broadcasts a bootstrap; `onPrepared` fires once a start has approved and proven everything it
   * needs. `prompts` (default `start`) off lets a start run on saved approvals. A start saves
   * `summary`, what it was quoted, with the record. `exclusive` runs each step that sends one
   * transaction.
   */
  advance(
    start = false,
    signal?: AbortSignal,
    {
      observeOnly = false,
      promptless = false,
      onPrepared,
      prompts = start,
      summary,
      exclusive,
    }: {
      observeOnly?: boolean
      promptless?: boolean
      onPrepared?: () => void
      prompts?: boolean
      summary?: MetadataMigrationSummary
      exclusive?: <T>(step: (operationId?: string) => Promise<T>) => Promise<T>
    } = {},
  ): Promise<MetadataMigrationRecord | null> {
    if (this.running) return this.running
    const run = this.lock(async () => {
      if (this.gate) {
        this.gate.signal = signal
        this.gate.prompts = prompts
      }
      const raw = await this.storage.getItem(this.key)
      const existing = raw ? (JSON.parse(raw) as MetadataMigrationRecord) : null
      if (!existing && !start) return null
      const record = existing ?? newMetadataMigration(this.key, await this.steps.binding())
      const result = await advanceMetadataMigration(
        record,
        this.steps,
        async (next) => {
          await this.storage.setItem(this.key, JSON.stringify(next))
          this.publish(next)
        },
        { start, signal, observeOnly, promptless, onPrepared, summary, exclusive },
      )
      this.publish(result)
      return result
    })
    this.running = run.finally(() => {
      this.running = undefined
      if (this.gate) {
        this.gate.signal = undefined
        this.gate.prompts = true
      }
    })
    return this.running
  }
}
