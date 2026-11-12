/** The wallet's color theme, which index.html applies from device storage before first paint. */
import { bestEffortSync } from "@obsidion/core/errors"
import { memoryStore, type ReadonlyStore } from "@obsidion/front-core"
import { deviceStorage } from "./rollupStorage"

export const THEMES = ["dark", "light"] as const
export type Theme = (typeof THEMES)[number]
const DEFAULT_THEME: Theme = "dark"

/** index.html reads this key too. */
export const THEME_KEY = "webwallet.theme"

/** The theme-color meta per theme; index.html sets these too. */
const BAR_COLOR: Record<Theme, string> = { dark: "#49087e", light: "#f4f3f9" }

export interface PageTheme {
  current: ReadonlyStore<Theme>
  /** Applies `theme` to the page and keeps it for the next load. */
  set(theme: Theme): void
}

/** The theme after `theme`, for a control that steps through them. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
}

/** The page's theme, starting from the one index.html applied to `root`. */
export function pageTheme(
  root: Pick<HTMLElement, "dataset">,
  themeColor?: Pick<HTMLMetaElement, "content"> | null,
): PageTheme {
  const applied = THEMES.find((theme) => theme === root.dataset.theme)
  const current = memoryStore<Theme>(applied ?? DEFAULT_THEME)
  return {
    current: current.readonly,
    set(theme) {
      if (theme === DEFAULT_THEME) delete root.dataset.theme
      else root.dataset.theme = theme
      if (themeColor) themeColor.content = BAR_COLOR[theme]
      current.set(theme)
      bestEffortSync(() => deviceStorage.setItem(THEME_KEY, theme), undefined)
    },
  }
}
