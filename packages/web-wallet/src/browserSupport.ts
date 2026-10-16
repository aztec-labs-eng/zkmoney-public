export const WASM_SIMD = "WebAssembly SIMD"

export const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
])

const isFunction = (value: unknown) => typeof value === "function"

export function missingBrowserFeatures(): string[] {
  const features: [string, boolean][] = [
    ["Promise.withResolvers", isFunction((Promise as { withResolvers?: unknown }).withResolvers)],
    ["Web Locks", isFunction((navigator as Navigator & { locks?: LockManager }).locks?.request)],
    [
      "Set.prototype.intersection",
      isFunction((Set.prototype as { intersection?: unknown }).intersection),
    ],
    [WASM_SIMD, typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE)],
  ]
  return features.filter(([, available]) => !available).map(([name]) => name)
}
