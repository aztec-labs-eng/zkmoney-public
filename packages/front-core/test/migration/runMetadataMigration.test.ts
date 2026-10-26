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
    expect(advance.mock.calls).toEqual([
      [
        true,
        expect.any(AbortSignal),
        { observeOnly: false, promptless: false, onPrepared: expect.any(Function) },
      ],
      [false, expect.any(AbortSignal), { observeOnly: false, promptless: false }],
    ])
    await vi.advanceTimersByTimeAsync(100)
    expect(advance).toHaveBeenCalledTimes(2)
  })

  it("tries a failed step again by itself, a failed start as a start with no prompt", async () => {
    vi.useFakeTimers()
    const onPrepared = vi.fn()
    const failed = { phase: "needsAttention", error: "relayer unavailable" }
    const advance = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockImplementationOnce(async (_start, _signal, opts) => {
        opts.onPrepared()
        return failed
      })
      .mockResolvedValueOnce({ phase: "done" })
    const run = runMetadataMigration({ advance } as unknown as MetadataMigrationController, {
      signal: new AbortController().signal,
      pollMs: 10,
      retry: true,
      onPrepared,
    })
    await vi.advanceTimersByTimeAsync(30)
    expect(await run).toMatchObject({ phase: "done" })
    expect(advance.mock.calls.map(([start, , opts]) => [start, opts.prompts])).toEqual([
      [true, undefined],
      [true, false],
      [false, undefined],
    ])
    expect(onPrepared).toHaveBeenCalledTimes(1)
  })

  it("carries a run promptless, never as a start, retrying a failed pass and stopping for the user", async () => {
    vi.useFakeTimers()
    const exclusive = <T>(step: () => Promise<T>) => step()
    const advance = vi
      .fn()
      .mockResolvedValueOnce({ phase: "awaitingMessages" })
      .mockResolvedValueOnce({ phase: "needsAttention", error: "relayer unavailable" })
      .mockResolvedValueOnce({ phase: "needsApproval", error: "needs you" })
    const run = runMetadataMigration({ advance } as unknown as MetadataMigrationController, {
      signal: new AbortController().signal,
      pollMs: 10,
      promptless: true,
      exclusive,
    })
    await vi.advanceTimersByTimeAsync(30)
    expect(await run).toMatchObject({ phase: "needsApproval" })
    expect(advance.mock.calls.map(([start, , opts]) => [start, opts])).toEqual([
      [false, { observeOnly: false, promptless: true, exclusive }],
      [false, { observeOnly: false, promptless: true, exclusive }],
      [false, { observeOnly: false, promptless: true, exclusive }],
    ])
  })

  it("returns once what is left runs without the user", async () => {
    const advance = vi.fn().mockResolvedValue({ phase: "awaitingMessages", bootstrapTx: "0x1" })
    const record = await runMetadataMigration(
      { advance } as unknown as MetadataMigrationController,
      { signal: new AbortController().signal, until: (r) => !!r.bootstrapTx },
    )
    expect(record).toMatchObject({ phase: "awaitingMessages" })
    expect(advance).toHaveBeenCalledTimes(1)
  })

  it("leaves a closed prompt, a stale plan and a repeating stop to the user", async () => {
    vi.useFakeTimers()
    for (const stop of [{ refused: true }, { stale: true }, { halt: "reverted" }]) {
      const advance = vi.fn().mockResolvedValue({ phase: "needsAttention", error: "x", ...stop })
      const run = runMetadataMigration({ advance } as unknown as MetadataMigrationController, {
        signal: new AbortController().signal,
        pollMs: 10,
        retry: true,
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(await run).toMatchObject({ phase: "needsAttention" })
      expect(advance).toHaveBeenCalledTimes(1)
    }
  })

  it("stops for the user once the retries run out", async () => {
    vi.useFakeTimers()
    const advance = vi.fn(async () => ({ phase: "needsAttention", error: "node unavailable" }))
    const run = runMetadataMigration({ advance } as unknown as MetadataMigrationController, {
      signal: new AbortController().signal,
      pollMs: 10,
      observeOnly: true,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await run).toMatchObject({ phase: "needsAttention" })
    expect(advance).toHaveBeenCalledTimes(6)
  })

  it("observes without the user's start and stops once the run needs the user", async () => {
    vi.useFakeTimers()
    const advance = vi
      .fn()
      .mockResolvedValueOnce({ phase: "arriving" })
      .mockResolvedValueOnce({ phase: "recovering" })
    const run = runMetadataMigration({ advance } as unknown as MetadataMigrationController, {
      signal: new AbortController().signal,
      pollMs: 10,
      observeOnly: true,
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(await run).toMatchObject({ phase: "recovering" })
    expect(advance.mock.calls).toEqual([
      [false, expect.any(AbortSignal), { observeOnly: true, promptless: false }],
      [false, expect.any(AbortSignal), { observeOnly: true, promptless: false }],
    ])
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
