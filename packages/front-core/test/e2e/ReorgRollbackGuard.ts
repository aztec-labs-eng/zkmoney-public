type SequencerController = {
  pauseSequencer: () => Promise<unknown>
  resumeSequencer: () => Promise<unknown>
  /** Resolves once in-flight block production has published and read its receipts. */
  drain: () => Promise<unknown>
}

type NonceHealerController = {
  pauseAndDrain: () => Promise<unknown>
  resumeAndRun: () => Promise<unknown>
}

const DRAIN_TIMEOUT_MS = 120_000

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Establishes a stable rollback boundary. Pausing only stops new blocks, so the sequencer is also
 * drained: a checkpoint publish still in flight when L1 is held and rolled back strands the
 * publisher on a nonce that never mines, and the sandbox stops checkpointing. The nonce healer
 * drains next, so no checkpoint publication can start between that drain and the L1 hold;
 * restoration is reversed so any rollback-created nonce gap is closed before checkpoint
 * publication resumes.
 */
export const withPausedReorgWriters = async <T>(
  sequencer: SequencerController,
  nonceHealer: NonceHealerController,
  operation: () => Promise<T>,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
): Promise<T> => {
  let sequencerPaused = false
  let nonceHealerPaused = false
  try {
    sequencerPaused = true
    await sequencer.pauseSequencer()
    await withTimeout(
      sequencer.drain(),
      drainTimeoutMs,
      "sequencer did not drain before the rollback",
    )
    nonceHealerPaused = true
    await nonceHealer.pauseAndDrain()
    return await operation()
  } finally {
    try {
      if (nonceHealerPaused) await nonceHealer.resumeAndRun()
    } finally {
      if (sequencerPaused) await sequencer.resumeSequencer()
    }
  }
}
