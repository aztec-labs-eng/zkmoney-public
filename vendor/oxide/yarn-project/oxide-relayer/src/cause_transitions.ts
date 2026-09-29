/**
 * Remembers the cause each work item was last logged with, so a poll loop reports a deferral when its cause changes
 * and stays quiet while the cause holds. Each loop owns one instance: the state is that loop's view of its own work.
 * It does not survive a restart, so a restarted relayer states the world once.
 */
export class CauseTransitions {
  private readonly causes = new Map<string, string>();

  /** True when the key has no cause yet, or a different one. Records the new cause either way. */
  changed(key: string, cause: string): boolean {
    const previous = this.causes.get(key);
    this.causes.set(key, cause);
    return previous !== cause;
  }

  /**
   * Drops the key. Call it where the work item leaves the store, so an item recreated under the same key reports its
   * cause again.
   */
  forget(key: string): void {
    this.causes.delete(key);
  }

  /** Drops every key under one prefix, for a store write that takes a whole group of work items at once. */
  forgetPrefix(prefix: string): void {
    for (const key of this.causes.keys()) {
      if (key.startsWith(prefix)) {
        this.causes.delete(key);
      }
    }
  }
}
