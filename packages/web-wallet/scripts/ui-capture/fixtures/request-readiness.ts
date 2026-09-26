import * as contexts from "./contexts"
import { useTagPresentationPending as actualPending } from "./registration"
import { fixtureState } from "./control"
export * from "./contexts"

// Only NewRequestLinkScreen imports these readiness controls. Its route gates stay real.
function readiness() {
  return fixtureState() ? new URLSearchParams(location.search).get("requestReadiness") : null
}

export function useAztecContext() {
  const context = contexts.useAztecContext()
  return readiness() === "connecting" ? { ...context, obsidionWallet: undefined } : context
}

export function useTagPresentationPending() {
  const pending = actualPending()
  return readiness() === "registering" || pending
}
