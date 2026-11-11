import type { localVerdict } from "./addressFacts"

/** Clear, a weak link, a direct link to the user's deposit, or a read that could not tell. */
export type RingTone = "clear" | "weak" | "direct" | "unknown"

/** The ring's three segments, clockwise from the top, each answered for one address. */
export interface PrivacyRing {
  /** Linked to you: a deposit from it links directly, a withdrawal to it weakly. */
  linked: RingTone
  /** Onchain activity: an address with history has something to link to. */
  activity: RingTone
  /** Public identity: an ENS name, an exchange or a known app says who receives. */
  identity: RingTone
}

export type PrivacyLevel = "High" | "Medium" | "Low"

/** `activity` is undefined when the chain read did not answer. */
export function privacyRing({
  local,
  activity,
  named,
}: {
  local: ReturnType<typeof localVerdict>
  activity: boolean | undefined
  named: boolean
}): PrivacyRing {
  return {
    linked: local?.kind === "linked-deposit" ? "direct" : local ? "weak" : "clear",
    activity: activity === undefined ? "unknown" : activity ? "weak" : "clear",
    identity: named ? "weak" : "clear",
  }
}

/** Any direct link makes it low, any segment not clear (an unread one too) medium; else high. */
export function privacyLevel(ring: PrivacyRing): PrivacyLevel {
  const tones = [ring.linked, ring.activity, ring.identity]
  if (tones.includes("direct")) return "Low"
  return tones.every((tone) => tone === "clear") ? "High" : "Medium"
}

/** The one line a ring's popover leads with: its worst finding, and the tone that shows it. */
export function privacyHeadline(ring: PrivacyRing): {
  line: "deposited" | "withdrew" | "transactions" | "named" | "unknown" | "clear"
  tone: RingTone
} {
  if (ring.linked === "direct") return { line: "deposited", tone: "direct" }
  if (ring.linked === "weak") return { line: "withdrew", tone: "weak" }
  if (ring.activity === "weak") return { line: "transactions", tone: "weak" }
  if (ring.identity === "weak") return { line: "named", tone: "weak" }
  if (ring.activity === "unknown") return { line: "unknown", tone: "unknown" }
  return { line: "clear", tone: "clear" }
}
