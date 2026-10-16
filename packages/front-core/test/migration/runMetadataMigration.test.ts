import { afterEach, describe, expect, it, vi } from "vitest"
import { runMetadataMigration } from "../../src/core/migration/runMetadataMigration"
import type { MetadataMigrationController } from "../../src/core/migration/MetadataMigrationController"

afterEach(() => vi.useRealTimers())

describe("authorized migration run", () => {
  it("continues through message waits and stops on an actionable error", async () => {
    vi.useFakeTimers()
    const advance = vi
      .fn()
      .mockResolvedValueOnce({ phase: "awaitingMessages" })
      .mockResolvedValueOnce({ phase: "needsAttention", error: "source unavailable" })
    const run = runMetadataMigration({ advance } as unknown as MetadataMigrationController, {
      signal: new AbortController().signal,
      pollMs: 10,
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(await run).toMatchObject({ phase: "needsAttention" })
    expect(advance.mock.calls).toEqual([[true], [false]])
    await vi.advanceTimersByTimeAsync(100)
    expect(advance).toHaveBeenCalledTimes(2)
  })

  it("pauses after an in-flight step without starting another transaction", async () => {
    const abort = new AbortController()
    let finish!: (record: unknown) => void
    const advance = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const snapshot = { phase: "broadcasting", bootstrapTx: "saved-before-rpc" }
    const run = runMetadataMigration(
      { advance, getSnapshot: () => snapshot } as unknown as MetadataMigrationController,
      { signal: abort.signal },
    )
    abort.abort()
    finish(snapshot)
    expect(await run).toEqual(snapshot)
    expect(advance).toHaveBeenCalledTimes(1)
  })
})
