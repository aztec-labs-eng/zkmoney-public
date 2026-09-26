// Process-wide guard against a double-refund of the same paylink. Keyed by the
// paylink `secret` (string). Shared across hook instances so two refund triggers
// (success sheet + activity detail) can't both submit a refund for one paylink.

const inFlight = new Set<string>()

export function isRefundInFlight(secret: string): boolean {
  return inFlight.has(secret)
}

export function markRefundInFlight(secret: string): void {
  inFlight.add(secret)
}

export function clearRefundInFlight(secret: string): void {
  inFlight.delete(secret)
}
