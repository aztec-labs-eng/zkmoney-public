import { useSyncExternalStore } from "react"
import { loadOnboardedIdentity } from "../identity/walletIdentity"
import { drawnOfferTag, subscribeDrawnOffer } from "./nameGrant"

/** Whether the drawn tag is still a draft: it stays hidden until the passkey is made. */
export function useTagUnpicked(): boolean {
  const draft = useSyncExternalStore(subscribeDrawnOffer, drawnOfferTag)
  return draft !== undefined && !loadOnboardedIdentity()
}

// The own tag typed so far, kept for the tab so the pick survives a detour through verification.
const DRAFT_KEY = "obsidion.tag-draft"

export function loadTagDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? ""
  } catch {
    return ""
  }
}

export function saveTagDraft(typed: string): void {
  try {
    if (typed) sessionStorage.setItem(DRAFT_KEY, typed)
    else sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // Unsaved: the sheet opens empty next time.
  }
}

/** The tag settled on before the passkey: a kept draw, a paid pick, or a past user's free one. */
export interface ChosenTag {
  tag: string
  route: "random" | "paid" | "past_user"
}

// Kept for the tab, so a reload at the passkey step resumes the same tag at the same price.
const CHOSEN_KEY = "obsidion.tag-chosen"

export function loadChosenTag(): ChosenTag | undefined {
  try {
    const saved = sessionStorage.getItem(CHOSEN_KEY)
    return saved ? (JSON.parse(saved) as ChosenTag) : undefined
  } catch {
    return undefined
  }
}

export function saveChosenTag(chosen: ChosenTag | undefined): void {
  try {
    if (chosen) sessionStorage.setItem(CHOSEN_KEY, JSON.stringify(chosen))
    else sessionStorage.removeItem(CHOSEN_KEY)
  } catch {
    // Unsaved: a reload asks for the tag again.
  }
}
