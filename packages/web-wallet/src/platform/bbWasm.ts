import { BarretenbergSync } from "@aztec/bb.js"
import { barretenbergWasm } from "./bbWasmPath"

/** Starts bb.js on these options; a failure resurfaces where the PXE first hashes. */
export function warmBarretenberg(): Promise<void> {
  return BarretenbergSync.initSingleton(barretenbergWasm()).then(
    () => {},
    () => {},
  )
}
