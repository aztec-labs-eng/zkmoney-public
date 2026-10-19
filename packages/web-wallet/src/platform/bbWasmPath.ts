/** Baked by `bbWasmAsset.ts`; undefined outside a build. */
declare const __BB_WASM_PATH__: string | undefined

/**
 * bb.js options that load its threads wasm from the build's own asset. Only where bb.js picks the
 * threads build, which needs shared memory; elsewhere it loads the wasm it carries. Kept apart from
 * bb.js, so passing the path on does not load it.
 */
export function barretenbergWasm(): { wasmPath?: string } {
  const wasmPath = typeof __BB_WASM_PATH__ === "string" ? __BB_WASM_PATH__ : undefined
  const shared = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true
  return wasmPath && shared ? { wasmPath } : {}
}
