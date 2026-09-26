/** True when running in a browser (window, document, and navigator all present). */
export const isBrowserEnvironment = (): boolean =>
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof navigator !== "undefined"
