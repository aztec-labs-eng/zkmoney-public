type SequencerController = {
  pauseSequencer: () => Promise<unknown>
  resumeSequencer: () => Promise<unknown>
}

type NonceHealerController = {
  pauseAndDrain: () => Promise<unknown>
  resumeAndRun: () => Promise<unknown>
}

/**
 * Establishes a stable rollback boundary. Sequencer shutdown comes first so it cannot start a new
 * checkpoint while the nonce healer drains; restoration is reversed so any rollback-created nonce
 * gap is closed before checkpoint publication resumes.
 */
export const withPausedReorgWriters = async <T>(
  sequencer: SequencerController,
  nonceHealer: NonceHealerController,
  operation: () => Promise<T>,
): Promise<T> => {
  let sequencerPaused = false
  let nonceHealerPaused = false
  try {
    await sequencer.pauseSequencer()
    sequencerPaused = true
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
