import { nativeLockScript } from "@obsidion/passkey-web"
import type { Plugin } from "vite"

const HEAD_OPEN = /<head\b[^>]*>/i
const CHARSET_META = /<meta\b[^>]*\bcharset\s*=[^>]*>/i

/**
 * Puts the passkey lock at the top of every page as a classic inline script, right after the
 * charset meta (so the charset stays inside the browser's prescan window) or first in head. It
 * runs before any module and before an extension's deferred page script.
 */
export function nativePasskeyLock(): Plugin {
  return {
    name: "native-passkey-lock",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const head = HEAD_OPEN.exec(html)
        if (!head) return html
        const headEnd = html.indexOf("</head>", head.index)
        const charset = CHARSET_META.exec(html.slice(head.index, headEnd < 0 ? undefined : headEnd))
        const at = charset
          ? head.index + charset.index + charset[0].length
          : head.index + head[0].length
        return `${html.slice(0, at)}<script>${nativeLockScript()}</script>${html.slice(at)}`
      },
    },
  }
}
