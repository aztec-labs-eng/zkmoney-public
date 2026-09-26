import type { ScanDestination, ScanResult } from "./scanPayload"

interface HandoffOptions {
  resolve: (text: string) => Promise<ScanResult>
  stopCamera: () => void
  onDestination: (destination: ScanDestination) => void
  onError: (message: string) => void
  onBusy: (busy: boolean) => void
}

/** One scanner opening accepts one destination, shared by frames and manual submission. */
export function createScanHandoff(options: HandoffOptions) {
  let disposed = false
  let busy = false
  let handedOff = false
  return {
    async submit(text: string): Promise<void> {
      if (disposed || busy || handedOff) return
      busy = true
      options.stopCamera()
      options.onBusy(true)
      let result: ScanResult
      try {
        result = await options.resolve(text)
      } catch {
        result = {
          kind: "error",
          message: "Couldn't read this code. Try again or paste another code.",
        }
      }
      if (disposed) return
      busy = false
      if (result.kind === "destination") handedOff = true
      options.onBusy(false)
      if (result.kind === "error") options.onError(result.message)
      else options.onDestination(result.destination)
    },
    dispose() {
      disposed = true
      options.stopCamera()
    },
  }
}
