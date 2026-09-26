import { useSyncExternalStore } from "react"

const query = "(max-width: 640px)"
let media: MediaQueryList | undefined
const getMedia = () => {
  // jsdom has no matchMedia; without it the layout reads as desktop.
  if (!media && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    media = window.matchMedia(query)
  }
  return media
}
const subscribe = (notify: () => void) => {
  const current = getMedia()
  current?.addEventListener("change", notify)
  return () => current?.removeEventListener("change", notify)
}

/** Matches the phone media queries in shell.css. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getMedia()?.matches ?? false,
    () => false,
  )
}
