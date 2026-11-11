import { memoryStore } from "@obsidion/front-core"

/** Home's claim sheet's check of whether a stashed link pays the open registration, for the hero. */
export interface LinkFunding {
  fragment: string
  state: "checking" | "review"
  amount?: bigint
}

/** The page's claims, by link fragment. */
export interface ClaimsState {
  /** Links with a claim in flight, from any surface: Home offers no prompt for one. */
  running: ReadonlySet<string>
  /** Why a claim of the link failed on this page: its review says so. */
  reasons: ReadonlyMap<string, string>
  /**
   * Links whose automatic claim ended on this page with no failure to keep: the user closed its
   * passkey prompt, or another device claimed the link. Home's own claim of the link stops here:
   * the review is the retry.
   */
  declined: ReadonlySet<string>
  /**
   * A request to open Home's claim flow on one stashed link, raised by the activation surfaces for
   * a ticket-funded registration whose bound link is on this tab, so the review that claims it
   * opens in the one place that owns the claim.
   */
  requested: string | null
  funding: LinkFunding | null
}

/**
 * The page's claim state: page state, so a claim outlives the screen and the session hand-off
 * that started it.
 */
export function createClaims() {
  const state = memoryStore<ClaimsState>({
    running: new Set(),
    reasons: new Map(),
    declined: new Set(),
    requested: null,
    funding: null,
  })
  const set = (patch: Partial<ClaimsState>) => state.set({ ...state.get(), ...patch })
  return {
    state: state.readonly,
    start(fragment: string) {
      const reasons = new Map(state.get().reasons)
      reasons.delete(fragment)
      const declined = new Set(state.get().declined)
      declined.delete(fragment)
      set({ running: new Set(state.get().running).add(fragment), reasons, declined })
    },
    end(fragment: string) {
      const running = new Set(state.get().running)
      running.delete(fragment)
      set({ running })
    },
    failed(fragment: string, reason: string) {
      set({ reasons: new Map(state.get().reasons).set(fragment, reason) })
    },
    decline(fragment: string) {
      set({ declined: new Set(state.get().declined).add(fragment) })
    },
    /** Opens Home's review of `fragment`; null once it closes. */
    request(fragment: string | null) {
      if (state.get().requested !== fragment) set({ requested: fragment })
    },
    fund(next: LinkFunding | null) {
      const { funding } = state.get()
      if (
        funding?.fragment === next?.fragment &&
        funding?.state === next?.state &&
        funding?.amount === next?.amount
      )
        return
      set({ funding: next })
    },
  }
}

export type Claims = ReturnType<typeof createClaims>
