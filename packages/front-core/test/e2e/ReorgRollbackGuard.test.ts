import { describe, expect, it, vi } from "vitest"
import { withPausedReorgWriters } from "./ReorgRollbackGuard"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("withPausedReorgWriters", () => {
  it("drains the sequencer before nonce healing and restores them in reverse order", async () => {
    const events: string[] = []
    const sequencer = {
      drain: vi.fn(async () => {
        events.push("sequencer:drained")
      }),
      pauseSequencer: vi.fn(async () => {
        events.push("sequencer:paused")
      }),
      resumeSequencer: vi.fn(async () => {
        events.push("sequencer:resumed")
      }),
    }
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {
        events.push("healer:paused")
      }),
      resumeAndRun: vi.fn(async () => {
        events.push("healer:resumed")
      }),
    }

    const result = await withPausedReorgWriters(sequencer, nonceHealer, async () => {
      events.push("rollback")
      return "complete"
    })

    expect(result).toBe("complete")
    expect(events).toEqual([
      "sequencer:paused",
      "sequencer:drained",
      "healer:paused",
      "rollback",
      "healer:resumed",
      "sequencer:resumed",
    ])
  })

  it("waits for both writers to drain before starting the rollback", async () => {
    const sequencerRelease = deferred()
    const sequencerStarted = deferred()
    const healerRelease = deferred()
    const healerStarted = deferred()
    const rollback = vi.fn(async () => "complete")
    const sequencer = {
      drain: vi.fn(async () => {}),
      pauseSequencer: vi.fn(async () => {
        sequencerStarted.resolve()
        await sequencerRelease.promise
      }),
      resumeSequencer: vi.fn(async () => {}),
    }
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {
        healerStarted.resolve()
        await healerRelease.promise
      }),
      resumeAndRun: vi.fn(async () => {}),
    }

    const guarded = withPausedReorgWriters(sequencer, nonceHealer, rollback)
    await sequencerStarted.promise
    expect(nonceHealer.pauseAndDrain).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()

    sequencerRelease.resolve()
    await healerStarted.promise
    expect(rollback).not.toHaveBeenCalled()

    healerRelease.resolve()
    await expect(guarded).resolves.toBe("complete")
    expect(rollback).toHaveBeenCalledOnce()
  })

  it("restores both controllers when the rollback fails", async () => {
    const rollbackError = new Error("rollback failed")
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {}),
      resumeAndRun: vi.fn(async () => {}),
    }
    const sequencer = {
      drain: vi.fn(async () => {}),
      pauseSequencer: vi.fn(async () => {}),
      resumeSequencer: vi.fn(async () => {}),
    }

    await expect(
      withPausedReorgWriters(sequencer, nonceHealer, async () => {
        throw rollbackError
      }),
    ).rejects.toBe(rollbackError)
    expect(nonceHealer.resumeAndRun).toHaveBeenCalledOnce()
    expect(sequencer.resumeSequencer).toHaveBeenCalledOnce()
  })

  it("restores both controllers when draining nonce healing fails", async () => {
    const drainError = new Error("drain failed")
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {
        throw drainError
      }),
      resumeAndRun: vi.fn(async () => {}),
    }
    const sequencer = {
      drain: vi.fn(async () => {}),
      pauseSequencer: vi.fn(async () => {}),
      resumeSequencer: vi.fn(async () => {}),
    }

    await expect(
      withPausedReorgWriters(sequencer, nonceHealer, async () => "unreachable"),
    ).rejects.toBe(drainError)
    expect(nonceHealer.resumeAndRun).toHaveBeenCalledOnce()
    expect(sequencer.resumeSequencer).toHaveBeenCalledOnce()
  })

  it("resumes the sequencer even when the first nonce-healing pass fails", async () => {
    const healingError = new Error("nonce healing failed")
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {}),
      resumeAndRun: vi.fn(async () => {
        throw healingError
      }),
    }
    const sequencer = {
      drain: vi.fn(async () => {}),
      pauseSequencer: vi.fn(async () => {}),
      resumeSequencer: vi.fn(async () => {}),
    }

    await expect(
      withPausedReorgWriters(sequencer, nonceHealer, async () => "complete"),
    ).rejects.toBe(healingError)
    expect(sequencer.resumeSequencer).toHaveBeenCalledOnce()
  })

  it("drains the sequencer after pausing it and before touching nonce healing or L1", async () => {
    const drained = deferred()
    const drainStarted = deferred()
    const rollback = vi.fn(async () => "complete")
    const sequencer = {
      pauseSequencer: vi.fn(async () => {}),
      resumeSequencer: vi.fn(async () => {}),
      drain: vi.fn(async () => {
        drainStarted.resolve()
        await drained.promise
      }),
    }
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {}),
      resumeAndRun: vi.fn(async () => {}),
    }

    const guarded = withPausedReorgWriters(sequencer, nonceHealer, rollback)
    await drainStarted.promise
    expect(sequencer.pauseSequencer).toHaveBeenCalledOnce()
    expect(nonceHealer.pauseAndDrain).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()

    drained.resolve()
    await expect(guarded).resolves.toBe("complete")
    expect(rollback).toHaveBeenCalledOnce()
  })

  it("resumes the sequencer when draining it fails", async () => {
    const drainError = new Error("drain failed")
    const rollback = vi.fn(async () => "unreachable")
    const sequencer = {
      pauseSequencer: vi.fn(async () => {}),
      resumeSequencer: vi.fn(async () => {}),
      drain: vi.fn(async () => {
        throw drainError
      }),
    }
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {}),
      resumeAndRun: vi.fn(async () => {}),
    }

    await expect(withPausedReorgWriters(sequencer, nonceHealer, rollback)).rejects.toBe(drainError)
    expect(sequencer.resumeSequencer).toHaveBeenCalledOnce()
    expect(nonceHealer.pauseAndDrain).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })

  it("fails and resumes the sequencer when it never drains", async () => {
    const rollback = vi.fn(async () => "unreachable")
    const sequencer = {
      pauseSequencer: vi.fn(async () => {}),
      resumeSequencer: vi.fn(async () => {}),
      drain: vi.fn(() => new Promise<void>(() => {})),
    }
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {}),
      resumeAndRun: vi.fn(async () => {}),
    }

    await expect(withPausedReorgWriters(sequencer, nonceHealer, rollback, 20)).rejects.toThrow(
      "sequencer did not drain before the rollback",
    )
    expect(sequencer.resumeSequencer).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
  })

  it("resumes the sequencer when the pause request fails", async () => {
    const pauseError = new Error("pause failed")
    const sequencer = {
      pauseSequencer: vi.fn(async () => {
        throw pauseError
      }),
      resumeSequencer: vi.fn(async () => {}),
      drain: vi.fn(async () => {}),
    }
    const nonceHealer = {
      pauseAndDrain: vi.fn(async () => {}),
      resumeAndRun: vi.fn(async () => {}),
    }

    await expect(
      withPausedReorgWriters(sequencer, nonceHealer, async () => "unreachable"),
    ).rejects.toBe(pauseError)
    expect(sequencer.resumeSequencer).toHaveBeenCalledOnce()
    expect(sequencer.drain).not.toHaveBeenCalled()
  })
})
