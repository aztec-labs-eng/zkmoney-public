import { Barretenberg, BarretenbergSync } from "@aztec-foundation/bb.js"
import type { BackendOptions } from "@aztec-foundation/bb.js"
import { createLogger } from "@aztec-labs/foundation/log"
import { bestEffort } from "@obsidion/core/errors"

/** Baked by `bbWasmAsset.ts`; undefined outside a build. */
declare const __BB_WASM_PATH__: string | undefined

// bb.js gives these iPhone settings only to an iPhone or iPad user agent, and iPadOS and a
// desktop-mode iPhone send a Mac one. A Web Worker has no touch points, so its page sends them.
// When the bb.js pin includes ZKM-1779 and ZKM-1782, read them from bb.js on the page.
const IOS_SETTINGS = { memory: { maximum: 2 ** 14 }, srsSize: 2 ** 18 }

export type IosSettings = Pick<BackendOptions, "memory" | "srsSize">

export const iosSettings = (): IosSettings =>
  /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1 ? IOS_SETTINGS : {}

/**
 * The options for each bb.js start: `ios`, and the threads wasm from the build's own asset. The
 * path is given only where bb.js picks the threads build, which needs shared memory; elsewhere it
 * loads the wasm it carries.
 */
export function barretenbergWasm(
  ios = iosSettings(),
): Pick<BackendOptions, "wasmPath" | "memory" | "srsSize"> {
  const wasmPath = typeof __BB_WASM_PATH__ === "string" ? __BB_WASM_PATH__ : undefined
  const shared = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true
  return {
    ...(wasmPath && shared ? { wasmPath } : {}),
    ...ios,
  }
}

/**
 * bb.js's instance for this thread, which the page's PXE prover takes too, so the wasm module, its
 * worker pool and the reference string load once. Its first start sets its options, and it outlives
 * every proof. The logger is the one the PXE's prover would pass, so its thread-count line prints.
 */
export function proverBackend(ios?: IosSettings): Promise<Barretenberg> {
  return Barretenberg.initSingleton({
    logger: createLogger("pxe:prover").verbose,
    ...barretenbergWasm(ios),
  })
}

export function syncBackend(ios?: IosSettings): Promise<BarretenbergSync> {
  return BarretenbergSync.initSingleton(barretenbergWasm(ios))
}

/** Starts the sync instance; a failure resurfaces where the PXE first hashes. */
export async function warmSyncBackend(): Promise<void> {
  const start = async () => syncBackend()
  await bestEffort("unknown", start())
}
