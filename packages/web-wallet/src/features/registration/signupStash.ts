import { bestEffortSync } from "@obsidion/core/errors"
import { memoryStore, normalizeTag } from "@obsidion/front-core"
import type { TabKey, tabStash } from "../../platform/storage/tabStash"

type TabStash = typeof tabStash

const KEYS = {
  token: "obsidion.name-grant",
  handle: "obsidion.name-grant-handle",
  drawnOffer: "obsidion.drawn-offer",
  chosenTag: "obsidion.tag-chosen",
  tagDraft: "obsidion.tag-draft",
} as const

/** The tag settled on before the passkey: a kept draw, a paid pick, or a past user's free one. */
export interface ChosenTag {
  tag: string
  route: "random" | "paid" | "past_user"
}

/**
 * This tab's signup before its passkey: the name grant a claim spends, the drawn tag waiting at
 * Home, the tag settled on, and the own tag typed so far.
 */
export interface SignupStashState {
  grant?: { token: string; handle?: string }
  drawnOffer?: string
  chosenTag?: ChosenTag
  tagDraft: string
}

/** A tab key's value, parsed; undefined when absent or unreadable. */
export function readStash<T = string>(
  stash: TabStash,
  key: TabKey,
  parse = (raw: string) => raw as T,
) {
  try {
    const raw = stash.get(key)
    return raw ? parse(raw) : undefined
  } catch {
    return undefined
  }
}

/** The drawn tag a reload resumes, read before the page opens. */
export const readDrawnOffer = (stash: TabStash) => readStash(stash, KEYS.drawnOffer)

/** The tag a claim route names, if the path is one. */
function claimRouteHandle(pathname: string): string | undefined {
  const route = /^\/claim\/([^/]+)\/?$/.exec(pathname)
  if (!route) return undefined
  try {
    return normalizeTag(decodeURIComponent(route[1])) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The page's signup values, kept for the tab so a reload resumes them. A tab whose storage refuses
 * keeps them for this page only.
 */
export function createSignupStash(stash: TabStash) {
  const token = readStash(stash, KEYS.token)
  const state = memoryStore<SignupStashState>({
    grant: token ? { token, handle: readStash(stash, KEYS.handle) } : undefined,
    drawnOffer: readDrawnOffer(stash),
    chosenTag: readStash<ChosenTag>(stash, KEYS.chosenTag, JSON.parse),
    tagDraft: readStash(stash, KEYS.tagDraft) ?? "",
  })
  const put = (key: TabKey, value: string | undefined) =>
    value ? stash.set(key, value) : stash.remove(key)
  const write = (next: Partial<SignupStashState>, keys: [TabKey, string | undefined][]) => {
    state.set({ ...state.get(), ...next })
    // Without tab storage the page keeps the values.
    bestEffortSync(() => {
      for (const [key, value] of keys) put(key, value)
    }, undefined)
  }
  const setGrant = (grant?: { token: string; handle?: string }) =>
    write({ grant }, [
      [KEYS.token, grant?.token],
      [KEYS.handle, grant?.handle],
    ])
  const grantToken = (handle?: string): string | undefined => {
    const { grant } = state.get()
    if (grant && !grant.handle) {
      setGrant(undefined)
      return undefined
    }
    return grant && (!handle || grant.handle === handle) ? grant.token : undefined
  }
  return {
    state: state.readonly,
    /** Retains an inbound grant for its claim route and takes the bearer token out of the URL. */
    stashInbound(): void {
      const url = new URL(window.location.href)
      if (!url.searchParams.has("grant")) return
      const token = url.searchParams.get("grant") || undefined
      const handle = claimRouteHandle(url.pathname)
      if (token && handle) setGrant({ token, handle })
      else if (!token) setGrant(undefined)
      url.searchParams.delete("grant")
      window.history.replaceState(window.history.state, "", url)
    },
    /** The grant behind a tag the claim server drew; the claim spends it like a link's. */
    stashDrawnGrant: (handle: string, token: string) => setGrant({ token, handle }),
    grantToken,
    /**
     * The grant the page at `url` runs on: its claim route's, or a bound-grant sign-in's. A grant
     * that another link left in this tab belongs to another flow.
     */
    pageGrantToken(url: URL): string | undefined {
      const bound = /^\/enter\/?$/.test(url.pathname) && url.searchParams.get("bound") === "1"
      const handle = bound
        ? normalizeTag(url.searchParams.get("handle") ?? "") ?? undefined
        : claimRouteHandle(url.pathname)
      return handle ? grantToken(handle) : undefined
    },
    scopeGrant(handle: string, token: string): void {
      if (grantToken(handle) === token) setGrant({ token, handle })
    },
    clearGrant(handle?: string, token?: string): void {
      if (handle && !grantToken(handle)) return
      if (token && grantToken(handle) !== token) return
      setGrant(undefined)
    },
    setDrawnOffer: (tag?: string) => write({ drawnOffer: tag }, [[KEYS.drawnOffer, tag]]),
    setChosenTag: (chosenTag?: ChosenTag) =>
      write({ chosenTag }, [[KEYS.chosenTag, chosenTag && JSON.stringify(chosenTag)]]),
    setTagDraft: (tagDraft: string) => write({ tagDraft }, [[KEYS.tagDraft, tagDraft]]),
  }
}

export type SignupStash = ReturnType<typeof createSignupStash>
