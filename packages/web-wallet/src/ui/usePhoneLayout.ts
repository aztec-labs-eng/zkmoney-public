import { useCallback, useMemo, useSyncExternalStore } from "react"

/** Whether the CSS media `query` matches, following its changes. */
export function useMediaQuery(query: string): boolean {
  // jsdom has no matchMedia; without it no query matches.
  const media = useMemo(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query)
        : undefined,
    [query],
  )
  const subscribe = useCallback(
    (notify: () => void) => {
      media?.addEventListener("change", notify)
      return () => media?.removeEventListener("change", notify)
    },
    [media],
  )
  return useSyncExternalStore(
    subscribe,
    () => media?.matches ?? false,
    () => false,
  )
}

/** Matches the phone media queries in shell.css. */
export function usePhoneLayout(): boolean {
  return useMediaQuery("(max-width: 640px)")
}
