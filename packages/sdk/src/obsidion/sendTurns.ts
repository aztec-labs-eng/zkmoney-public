import type { ProvingStage } from "@obsidion/core/types"

/** Where a send reports the stage it reached, under its operation's id. */
export interface SendProgress {
  stage(stage: ProvingStage, operationId: string, txHash?: string): void
  /** `true` while the send waits a bounded time for a block to include the last send's tx. */
  lastSendWait(waiting: boolean): void
}

/** Who holds the wallet's anchor pin: one send at a time, and the next waits its turn. */
export interface SendTurns {
  /** Runs `send` once every send asked for before it has ended; it reports to `progress`. */
  turn<T>(send: (progress: SendProgress) => Promise<T>): Promise<T>
}

const UNHEARD: SendProgress = { stage: () => undefined, lastSendWait: () => undefined }

/** Turns in call order, for a host with no prover of its own; no one hears their stages. */
export function serialTurns(): SendTurns {
  let last: Promise<unknown> = Promise.resolve()
  return {
    turn(send) {
      const run = last.then(() => send(UNHEARD))
      last = run.catch(() => undefined)
      return run
    },
  }
}
