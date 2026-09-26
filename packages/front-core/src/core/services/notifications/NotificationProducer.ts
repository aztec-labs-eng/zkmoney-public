import { logger } from "src/utils/logger"

export interface NotificationFeed<TItem> {
  list(): TItem[]
  onChanged(listener: (items: TItem[]) => void): () => void
}

export interface NotificationProducer {
  id: string
  start(): void
  stop(): void
  flush(): Promise<void>
}

interface SnapshotNotificationProducerArgs<TItem> {
  id: string
  feed: NotificationFeed<TItem>
  label: string
  process: (items: TItem[], baselineMs: number) => Promise<void>
}

export class SnapshotNotificationProducer<TItem> implements NotificationProducer {
  readonly id: string
  private feed: NotificationFeed<TItem>
  private label: string
  private processSnapshot: (items: TItem[], baselineMs: number) => Promise<void>
  private unsubscribe: (() => void) | null = null
  private baselineMs: number | null = null
  private processChain: Promise<void> = Promise.resolve()

  constructor({ id, feed, label, process }: SnapshotNotificationProducerArgs<TItem>) {
    this.id = id
    this.feed = feed
    this.label = label
    this.processSnapshot = process
  }

  start(): void {
    if (this.unsubscribe) return
    this.baselineMs = Date.now()
    this.unsubscribe = this.feed.onChanged((items) => {
      this.enqueue(items)
    })
    this.enqueue(this.feed.list())
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async flush(): Promise<void> {
    await this.processChain
  }

  private enqueue(items: TItem[]): void {
    this.processChain = this.processChain.catch(() => undefined).then(() => this.process(items))
  }

  private async process(items: TItem[]): Promise<void> {
    const baseline = this.baselineMs
    if (baseline == null) return

    try {
      await this.processSnapshot(items, baseline)
    } catch (err) {
      logger.warn(`[${this.label}] notification producer failed:`, err)
    }
  }
}

export class NotificationProducerRegistry implements NotificationProducer {
  private static instance: NotificationProducerRegistry | null = null
  readonly id = "registry"
  private producers = new Map<string, NotificationProducer>()
  private running = false

  static get(): NotificationProducerRegistry {
    if (!NotificationProducerRegistry.instance) {
      NotificationProducerRegistry.instance = new NotificationProducerRegistry()
    }
    return NotificationProducerRegistry.instance
  }

  static resetForTests(): void {
    NotificationProducerRegistry.instance?.stop()
    NotificationProducerRegistry.instance = null
  }

  register(producer: NotificationProducer): void {
    const existing = this.producers.get(producer.id)
    if (existing && existing !== producer && this.running) {
      existing.stop()
    }
    this.producers.set(producer.id, producer)
    if (this.running) producer.start()
  }

  start(): void {
    this.running = true
    for (const producer of this.producers.values()) {
      producer.start()
    }
  }

  stop(): void {
    for (const producer of this.producers.values()) {
      producer.stop()
    }
    this.running = false
  }

  async flush(): Promise<void> {
    await Promise.all(Array.from(this.producers.values(), (producer) => producer.flush()))
  }
}
