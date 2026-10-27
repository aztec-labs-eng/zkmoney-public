import { QueueStatus } from "@obsidion/sdk"
import { EventEmitter } from "eventemitter3"
import { TransactionType } from "src/types"
import { v4 as uuidv4 } from "uuid"

export type TransactionQueueItem = {
  id: string
  txHash?: string
  description: string
  status: QueueStatus
  progress: number
  error?: string
  startTime: number
  endTime?: number
  estimatedDuration?: number
  type?: TransactionType
}

// exported so the in-memory queue→storage write-through bridge in
// `TxLifecycleService` can subscribe by reference rather than by string literal — matches
// the existing pattern used by `removeAllListeners`.
export const QUEUE_UPDATE_EVENT = "queueUpdated"
const TRANSACTION_COMPLETE = "transactionComplete"

export class TransactionTracker extends EventEmitter {
  private queue: TransactionQueueItem[] = []
  private static instance: TransactionTracker

  constructor() {
    super()
  }

  public static getInstance(): TransactionTracker {
    if (!TransactionTracker.instance) {
      TransactionTracker.instance = new TransactionTracker()
    }
    return TransactionTracker.instance
  }

  public async addToQueue(description: string, estimatedDuration?: number): Promise<string> {
    const id = uuidv4()
    const item: TransactionQueueItem = {
      id,
      description,
      status: QueueStatus.PENDING,
      progress: 0,
      startTime: Date.now(),
      estimatedDuration,
    }

    this.queue.push(item)
    this.emit(QUEUE_UPDATE_EVENT, this.queue)
    return id
  }

  public updateStatus(
    id: string,
    status: TransactionQueueItem["status"],
    progress?: number,
    error?: string,
    txHash?: string,
  ) {
    const item = this.queue.find((item) => item.id === id)
    if (!item) {
      return
    }

    item.status = status
    if (progress !== undefined) item.progress = progress
    if (error) item.error = error
    if (txHash) item.txHash = txHash

    if (status === QueueStatus.SUCCESS || status === QueueStatus.FAILED) {
      item.endTime = Date.now()
      this.emit(TRANSACTION_COMPLETE, { ...item })
    }

    this.emit(QUEUE_UPDATE_EVENT, this.queue)
  }

  public getQueue(): TransactionQueueItem[] {
    return [...this.queue]
  }

  /**
   * Read a single queue item by id without copying the whole queue, for a
   * caller that needs the row's current `status` synchronously. Returns a
   * snapshot copy so callers cannot mutate the in-memory queue directly.
   */
  public getQueueItem(id: string): TransactionQueueItem | undefined {
    const item = this.queue.find((q) => q.id === id)
    return item ? { ...item } : undefined
  }

  public async removeFromQueue(id: string) {
    this.queue = this.queue.filter((item) => item.id !== id)
    this.emit(QUEUE_UPDATE_EVENT, this.queue)
  }

  // Method to remove specific listeners for our events and optionally all events
  public removeAllListeners(event?: string | symbol): this {
    if (event) {
      super.removeAllListeners(event)
    } else {
      // Remove listeners for our specific events
      super.removeAllListeners(QUEUE_UPDATE_EVENT)
      super.removeAllListeners(TRANSACTION_COMPLETE)
      super.removeAllListeners()
    }
    return this
  }

  // Method to clean up all listeners when no longer needed
  public cleanup(): void {
    this.removeAllListeners(QUEUE_UPDATE_EVENT)
    this.removeAllListeners(TRANSACTION_COMPLETE)
  }
}
