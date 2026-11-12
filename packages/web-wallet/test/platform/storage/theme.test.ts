import { afterEach, describe, expect, it } from "vitest"
import {
  nextTheme,
  pageTheme,
  THEMES,
  THEME_KEY,
  type Theme,
} from "../../../src/platform/storage/theme"

const BAR_COLOR: Record<Theme, string> = { dark: "#49087e", light: "#f4f3f9" }

describe("pageTheme", () => {
  afterEach(() => localStorage.clear())

  it.each(THEMES)("applies and keeps %s, and tints the browser bar", (theme) => {
    const root = document.createElement("html")
    const themeColor = document.createElement("meta")
    const page = pageTheme(root, themeColor)
    page.set(theme)
    expect(page.current.get()).toBe(theme)
    expect(root.dataset.theme ?? "dark").toBe(theme)
    expect(themeColor.content).toBe(BAR_COLOR[theme])
    expect(localStorage.getItem(THEME_KEY)).toBe(theme)
    expect(pageTheme(root).current.get()).toBe(theme)
  })

  it("steps through every theme and back to the first", () => {
    const seen: Theme[] = [THEMES[0]]
    while (seen.length <= THEMES.length) seen.push(nextTheme(seen[seen.length - 1]))
    expect(new Set(seen.slice(0, -1)).size).toBe(THEMES.length)
    expect(seen[THEMES.length]).toBe(THEMES[0])
  })
})
