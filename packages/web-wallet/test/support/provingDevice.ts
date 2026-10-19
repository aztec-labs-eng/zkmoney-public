/** Puts the page on a device of this class; the returned undo restores it. */
export function stubProvingDevice(isolated: boolean, cores: number): () => void {
  const undo = [
    override(globalThis, "crossOriginIsolated", isolated),
    override(navigator, "hardwareConcurrency", cores),
  ]
  return () => undo.forEach((restore) => restore())
}

function override(target: object, key: string, value: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, get: () => value })
  return () =>
    own ? Object.defineProperty(target, key, own) : delete (target as Record<string, unknown>)[key]
}
