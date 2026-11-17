import { scrubErrorText } from "@obsidion/core/errors"
import { defaultStackParser } from "@sentry/browser"

export interface ReportFrame {
  filename: string
  function?: string
  lineno?: number
  colno?: number
}

const SCRIPT = /\.[cm]?[jt]sx?$/

/**
 * A stack as frames, oldest call first. A frame keeps its path, scrubbed function and position only
 * when it is one of the wallet's own scripts. Any other, such as an extension's or an inline
 * script's (whose file is the page URL), says only that it is `[external]`.
 */
export function stackFrames(stack: string, origin: string): ReportFrame[] {
  return defaultStackParser(stack).map(({ filename, function: name, lineno, colno }) => {
    const path = filename?.startsWith(`${origin}/`)
      ? filename.slice(origin.length).split(/[?#]/)[0]!
      : ""
    return SCRIPT.test(path)
      ? { filename: path, function: name && scrubErrorText(name).slice(0, 256), lineno, colno }
      : { filename: "[external]" }
  })
}
