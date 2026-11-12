/**
 * A module download that fails mid-load (a network blip) reloads the page, twice at most per tab. A
 * browser keeps a failed dynamic import failed for the document, so only a reload can fetch it again.
 * The wallet's boot chunk and the PXE share the count.
 */
import { tabStash } from "./storage/tabStash"

const DOWNLOAD_RELOADS_KEY = "pxeBoot.downloadReloads"
const MAX_DOWNLOAD_RELOADS = 2
const MODULE_DOWNLOAD_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/
// Vite's preload helper rejects a chunk's failed stylesheet with a plain Error.
const CSS_DOWNLOAD_FAILURE = /^Unable to preload CSS for /

export function isModuleDownloadFailure(e: unknown): boolean {
  if (e instanceof AggregateError) return e.errors.some(isModuleDownloadFailure)
  if (e instanceof TypeError) return MODULE_DOWNLOAD_FAILURE.test(e.message)
  return e instanceof Error && CSS_DOWNLOAD_FAILURE.test(e.message)
}

export function takeDownloadReload(): boolean {
  try {
    const reloads = Number(tabStash.get(DOWNLOAD_RELOADS_KEY)) || 0
    if (reloads >= MAX_DOWNLOAD_RELOADS) return false
    tabStash.set(DOWNLOAD_RELOADS_KEY, String(reloads + 1))
    return true
  } catch {
    return false
  }
}

export function clearDownloadReloads(): void {
  try {
    tabStash.remove(DOWNLOAD_RELOADS_KEY)
  } catch {
    return
  }
}

/** `load`'s module, or a reload when its download fails and the tab has a reload left. */
export function importOrReload<T>(
  load: () => Promise<T>,
  reload = () => location.reload(),
): Promise<T> {
  return load().catch((e: unknown) => {
    if (!isModuleDownloadFailure(e) || !takeDownloadReload()) throw e
    reload()
    return new Promise<never>(() => {})
  })
}
