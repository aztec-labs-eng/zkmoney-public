export function missingBrowserFeatures(): string[] {
  const features: [string, unknown][] = [
    ["Promise.withResolvers", (Promise as { withResolvers?: unknown }).withResolvers],
    ["Web Locks", (navigator as Navigator & { locks?: LockManager }).locks?.request],
    ["Set.prototype.intersection", (Set.prototype as { intersection?: unknown }).intersection],
  ]
  return features.filter(([, fn]) => typeof fn !== "function").map(([name]) => name)
}
