const EXTENSION_SCHEME = /^(chrome|moz|safari-web)-extension:\/\//
const FRAME_URL = /^(?:\s+at (?:.*?\()?|[^\n@]*@)([a-z][a-z0-9+.-]*:\/\/[^\s()]+)/gm

export function isExtensionError(filename: string | undefined, error: unknown): boolean {
  if (filename && EXTENSION_SCHEME.test(filename)) return true
  const stack = error instanceof Error ? error.stack : undefined
  if (!stack) return false
  const frameUrls = [...stack.matchAll(FRAME_URL)].map((m) => m[1])
  return frameUrls.length > 0 && frameUrls.every((url) => EXTENSION_SCHEME.test(url))
}
