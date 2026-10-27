import { dependencies } from "../package.json"

// 30 minutes before the v6 payload.
export const FREEZE_AT = Date.UTC(2026, 9, 26, 7, 30)
/** When the web comes back on v6. */
export const WINDOW_ENDS = Date.UTC(2026, 9, 26, 13)
// A poll, not one long timer: timers fire late after sleep.
const CHECK_MS = 15_000

/** `next` merges forward into the v6 wallet, which must not freeze. */
export function freezesBuild(deps: Record<string, string | undefined>, dev: boolean): boolean {
  return !dev && !!deps["@aztec/aztec.js"]?.startsWith("v5")
}

export const FREEZES = freezesBuild(dependencies, import.meta.env.DEV)

export function isFrozen(now = Date.now()): boolean {
  return now >= FREEZE_AT
}

export function reloadAtFreeze(
  // Lazy: keeps the wallet store out of the boot chunk.
  reload = () => void import("./platform/storage/walletStorage").then((m) => m.reloadPage()),
  now = () => Date.now(),
): void {
  const timer = setInterval(() => {
    if (!isFrozen(now())) return
    clearInterval(timer)
    reload()
  }, CHECK_MS)
}

/** The maintenance page refreshes itself, so it loads whatever is published next. */
export async function showFreezePage(): Promise<void> {
  const { default: html } = await import("../maintenance/maintenance.html?raw")
  document.open()
  document.write(
    html.replace('data-until=""', `data-until="${new Date(WINDOW_ENDS).toISOString()}"`),
  )
  document.close()
}
