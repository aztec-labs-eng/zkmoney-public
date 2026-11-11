/**
 * The page's one prover: every proof on the page goes through it. It orders work at two levels.
 *
 * Flows: user-initiated transactions go before background proving (the SIPA pool refill, a deposit
 * address's broadcast, an upgrade's automatic step). Background proofs run one at a time, none
 * starts while a user flow is active, and a user flow waits out a background proof already past the
 * point of no return: mid-proof abort is not possible in the browser (the abort signal is read only
 * at phase boundaries, and bb.js has no cancellation API).
 *
 * Sends: the wallet takes a `turn` for each send, which holds its anchor pin from the entry sync to
 * the end. The send reports its stages to the turn, and `progress` shows them. One send runs at a time and the next waits, so a second send never re-selects the notes
 * the first is spending. A user flow and a background proof never run at once, so the turns need
 * no priority of their own: they run in call order. The PXE's own job queue stays underneath and
 * runs every sync, simulation and proof first in, first out.
 *
 * Correctness leans on JS single-threading: `runUserFlow` raises its count synchronously before
 * its first await, and a background proof starts in the same synchronous block that checks
 * `userFlowActive` — no interleaving can slip between the two.
 */
import type { ProvingStage } from "@obsidion/core/types"
import { serialTurns, type SendProgress, type SendTurns } from "@obsidion/sdk"
import { memoryStore, type ReadonlyStore } from "./store"

/** The last stage an operation's send reached, and when; Mining carries the tx hash. */
export interface OperationStage {
  stage: ProvingStage
  at: number
  txHash?: string
}

/** What the page's proofs show while they run. */
export interface ProvingProgress {
  /** The stages of the send whose turn is open or ended last, by operation id. */
  stages: Readonly<Record<string, OperationStage>>
  /** The send whose turn is open waits for a block to include the last send's tx. */
  waitingForLastSend: boolean
  /** The page's passkey signatures: how many began and ended, and whether the last one failed. */
  signing: { started: number; ended: number; failed: boolean }
}

/** Where the page's passkey signers report each signature, which a proof waits for. */
export interface SigningReport {
  start(): void
  /** `failed` when the signature was refused or cancelled. */
  end(failed?: boolean): void
}

export interface ProvingState {
  /** User-initiated tx flows running. */
  userFlows: number
  /** A background proof is reserved. */
  reserved: boolean
}

export interface Prover extends SendTurns {
  readonly state: ReadonlyStore<ProvingState>
  readonly progress: ReadonlyStore<ProvingProgress>
  readonly signing: SigningReport
  /** Run a user-initiated tx flow: raise the count, wait out any in-flight background proof. */
  runUserFlow<T>(flow: () => Promise<T>): Promise<T>
  /**
   * Reserve the prover for a background proof. With none reserved and no user flow running it
   * starts now; otherwise once every one reserved before it has ended and no user flow runs. User
   * flows raised after it starts wait it out. The failure still belongs to the caller — a failed
   * background proof must never fail a user flow. Never call it from inside a reserved proof or a
   * user flow: it would wait on itself.
   */
  runBackground<T>(start: () => Promise<T>): Promise<T>
}

/** Background provers must not start while this holds. */
export const userFlowActive = (s: ProvingState): boolean => s.userFlows > 0

/** A user flow runs or a background proof is reserved: a caller that must not wait defers. */
export const provingBusy = (s: ProvingState): boolean => userFlowActive(s) || s.reserved

/** The page's one prover: every session of the page proves through it. */
export function createProver({ now }: { now: () => number }): Prover {
  const state = memoryStore<ProvingState>({ userFlows: 0, reserved: false })
  const sends = serialTurns()
  const progress = memoryStore<ProvingProgress>({
    stages: {},
    waitingForLastSend: false,
    signing: { started: 0, ended: 0, failed: false },
  })
  const heard: SendProgress = {
    stage(stage, operationId, txHash) {
      const current = progress.get()
      const entry = { stage, at: now(), ...(txHash ? { txHash } : {}) }
      progress.set({ ...current, stages: { ...current.stages, [operationId]: entry } })
    },
    lastSendWait: (waiting) => progress.set({ ...progress.get(), waitingForLastSend: waiting }),
  }
  const signing = (next: Partial<ProvingProgress["signing"]>) =>
    progress.set({ ...progress.get(), signing: { ...progress.get().signing, ...next } })
  const flows = (delta: number) =>
    state.set({ ...state.get(), userFlows: state.get().userFlows + delta })
  /** The background proof that started last. */
  let backgroundProve: Promise<unknown> = Promise.resolve()
  /** Settles once every background proof reserved so far has ended; unset while none is. */
  let tail: Promise<void> | undefined
  const flowsIdle = () =>
    new Promise<void>((resolve) => {
      const off = state.subscribe(() => {
        if (userFlowActive(state.get())) return
        off()
        resolve()
      })
    })
  const release = (ended: Promise<void>) => {
    if (tail !== ended) return
    tail = undefined
    state.set({ ...state.get(), reserved: false })
  }
  return {
    state: state.readonly,
    progress: progress.readonly,
    // A new send's stages replace the last one's.
    turn: (send) =>
      sends.turn(() => {
        progress.set({ ...progress.get(), stages: {} })
        return send(heard)
      }),
    signing: {
      start: () => signing({ started: progress.get().signing.started + 1, failed: false }),
      end: (failed = false) => signing({ ended: progress.get().signing.ended + 1, failed }),
    },
    async runUserFlow(flow) {
      flows(1)
      try {
        await backgroundProve
        return await flow()
      } finally {
        flows(-1)
      }
    },
    runBackground(start) {
      const begin = () => {
        const started = start()
        backgroundProve = Promise.allSettled([started])
        return started
      }
      const run =
        !tail && !userFlowActive(state.get())
          ? begin()
          : (tail ?? Promise.resolve()).then(async () => {
              while (userFlowActive(state.get())) await flowsIdle()
              return begin()
            })
      const ended: Promise<void> = run.then(
        () => release(ended),
        () => release(ended),
      )
      tail = ended
      state.set({ ...state.get(), reserved: true })
      return run
    },
  }
}
