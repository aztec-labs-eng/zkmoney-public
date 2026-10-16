import type { Hex } from "viem"
import type { PastUserProof } from "./pastUserClaim"

/** `not_found` and `claimed` end a check that cannot pass with this wallet. */
export type PastUserStep = "connect" | "sign" | "check" | "confirmed" | "not_found" | "claimed"

export interface PastUserState {
  step: PastUserStep
  account?: Hex
  error?: string
}

export type PastUserEvent =
  | { type: "connected"; account: Hex }
  | { type: "signed" }
  | { type: "confirmed" }
  | { type: "failed"; error: string }
  | { type: "ended"; step: "not_found" | "claimed" }
  | { type: "reset" }

const FOLLOWS = { signed: ["sign", "check"], confirmed: ["check", "confirmed"] } as const

/** Each step moves only from the one before it; a connected wallet starts over at signing. */
export function pastUserReducer(state: PastUserState, event: PastUserEvent): PastUserState {
  switch (event.type) {
    case "connected":
      return { step: "sign", account: event.account }
    case "failed":
      return { ...state, error: event.error }
    case "ended":
      return { step: event.step, account: state.account }
    case "reset":
      return { step: "connect" }
    default: {
      const [from, to] = FOLLOWS[event.type]
      return state.step === from && !state.error ? { ...state, step: to } : state
    }
  }
}

const storageKey = (owner: string) => `zkm.pastUserCheck.${owner}`

/** Keeps a passed check for the tab. */
export function rememberPastUser(owner: string, state: PastUserState) {
  if (state.step !== "confirmed") return
  try {
    sessionStorage.setItem(storageKey(owner), JSON.stringify(state))
  } catch {}
}

export function recallPastUser(owner: string | undefined): PastUserState {
  try {
    const saved = owner && sessionStorage.getItem(storageKey(owner))
    const state = saved ? (JSON.parse(saved) as PastUserState) : undefined
    if (state?.step === "confirmed" && !state.error)
      return { step: "confirmed", account: state.account }
  } catch {}
  return { step: "connect" }
}

/**
 * A past user verified before any passkey: the old wallet and its owner-less proof, kept for the tab
 * until a grant spends it. `tag` is the tag the grant went to.
 */
export interface PastUserVerified extends PastUserProof {
  account: Hex
  tag?: string
}

const VERIFIED_KEY = "zkm.pastUserVerified"
const verifiedListeners = new Set<() => void>()
let verifiedCache: { raw: string | null; value: PastUserVerified | undefined } | undefined

export function loadPastUserVerified(): PastUserVerified | undefined {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(VERIFIED_KEY)
  } catch {}
  // One object per stored value, so useSyncExternalStore sees a stable snapshot.
  if (verifiedCache?.raw !== raw) {
    verifiedCache = { raw, value: raw ? (JSON.parse(raw) as PastUserVerified) : undefined }
  }
  return verifiedCache.value
}

export function savePastUserVerified(verified: PastUserVerified): void {
  try {
    sessionStorage.setItem(VERIFIED_KEY, JSON.stringify(verified))
  } catch {}
  verifiedListeners.forEach((listener) => listener())
}

export function clearPastUserVerified(): void {
  try {
    sessionStorage.removeItem(VERIFIED_KEY)
  } catch {}
  verifiedListeners.forEach((listener) => listener())
}

export function subscribePastUserVerified(listener: () => void): () => void {
  verifiedListeners.add(listener)
  return () => verifiedListeners.delete(listener)
}
