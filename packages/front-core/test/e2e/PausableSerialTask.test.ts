import { describe, expect, it, vi } from "vitest"
import { PausableSerialTask } from "./PausableSerialTask"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("PausableSerialTask", () => {
  it("drains an in-flight task before pausing and does not start another while paused", async () => {
    const first = deferred()
    const started = deferred()
    const task = vi.fn(async () => {
      started.resolve()
      await first.promise
    })
    const controller = new PausableSerialTask(task, 60_000, () => {})
    controller.start()

    const run = controller.runNow()
    await started.promise

    let drained = false
    const pause = controller.pauseAndDrain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    first.resolve()
    await Promise.all([run, pause])
    expect(drained).toBe(true)

    await controller.runNow()
    expect(task).toHaveBeenCalledTimes(1)

    await controller.resumeAndRun()
    expect(task).toHaveBeenCalledTimes(2)
    await controller.stop()
  })

  it("serializes overlapping triggers", async () => {
    const releases = [deferred(), deferred()]
    const starts = [deferred(), deferred()]
    let active = 0
    let maxActive = 0
    let call = 0
    const controller = new PausableSerialTask(
      async () => {
        const index = call++
        active++
        maxActive = Math.max(maxActive, active)
        starts[index].resolve()
        await releases[index].promise
        active--
      },
      60_000,
      () => {},
    )
    controller.start()

    const first = controller.runNow()
    const second = controller.runNow()
    await starts[0].promise
    expect(call).toBe(1)

    releases[0].resolve()
    await starts[1].promise
    expect(call).toBe(2)
    expect(maxActive).toBe(1)

    releases[1].resolve()
    await Promise.all([first, second])
    await controller.stop()
  })
})
