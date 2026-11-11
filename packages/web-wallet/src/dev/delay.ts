/** A mock's fake latency, so its loading frame shows. */
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
