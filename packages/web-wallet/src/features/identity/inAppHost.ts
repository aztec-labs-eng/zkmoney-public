import { currentIsInAppBrowser } from "@obsidion/passkey-web"

/**
 * Marks the document when an app's built-in browser hosts it, so the styles can keep the host's own
 * bar clear. The user agent does not change within a page, so the mark is never removed.
 */
export function markInAppBrowser(root: HTMLElement = document.documentElement): void {
  if (currentIsInAppBrowser()) root.dataset.inAppBrowser = ""
}
