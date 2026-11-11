/** App-wide logger — use instead of `console` in front-core. Routine output can be gated off. */

// eslint-disable-next-line no-restricted-syntax -- debt
let enabled = true

/** Gates log/info/debug/warn. `error` always emits. */
export function setLoggingEnabled(value: boolean): void {
  enabled = value
}

export function isLoggingEnabled(): boolean {
  return enabled
}

export const logger = {
  log: (...args: unknown[]): void => {
    if (enabled) console.log(...args)
  },
  info: (...args: unknown[]): void => {
    if (enabled) console.info(...args)
  },
  debug: (...args: unknown[]): void => {
    if (enabled) console.debug(...args)
  },
  warn: (...args: unknown[]): void => {
    if (enabled) console.warn(...args)
  },
  /** Always emits — real failures must reach release crash logs. */
  error: (...args: unknown[]): void => {
    console.error(...args)
  },
}
