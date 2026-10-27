import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { Connect, Plugin } from "vite"

const require = createRequire(import.meta.url)

/** bb.js's gzipped threads wasm: the bytes its browser build carries as a base64 module. */
export const BB_THREADS_WASM = path.join(
  path.dirname(require.resolve("@aztec-foundation/bb.js")),
  "barretenberg_wasm/barretenberg-threads.wasm.gz",
)

/**
 * bb.js's threads wasm as its own asset, which bb.js fetches when given `wasmPath` (it inserts
 * `-threads` after the file's stem). The host serves it with `Content-Encoding: gzip`, so the
 * browser inflates it off the main thread and bb.js skips its JS ungzip and the base64 module; a
 * host that does not leaves bb.js to ungzip the same bytes. The dev server keeps bb.js's own.
 * `__BB_WASM_PATH__` is the `wasmPath`, undefined outside a build.
 */
export function bbWasmAsset(source = BB_THREADS_WASM): Plugin {
  let fileName: string | undefined
  return {
    name: "bb-wasm-asset",
    config(_config, { command }) {
      if (command !== "build") return { define: { __BB_WASM_PATH__: "undefined" } }
      const stem = `barretenberg-${createHash("sha256")
        .update(readFileSync(source))
        .digest("hex")
        .slice(0, 10)}`
      fileName = `assets/${stem}-threads.wasm.gz`
      return { define: { __BB_WASM_PATH__: JSON.stringify(`/assets/${stem}.wasm.gz`) } }
    },
    generateBundle() {
      if (fileName) this.emitFile({ type: "asset", fileName, source: readFileSync(source) })
    },
    // As the deployed host serves it (web-wallet-publish.sh), so a preview exercises the same path.
    configurePreviewServer(server) {
      server.middlewares.use(gzipEncodedWasm)
    },
  }
}

const gzipEncodedWasm: Connect.NextHandleFunction = (req, res, next) => {
  if ((req.url ?? "").split("?")[0].endsWith(".wasm.gz")) {
    res.setHeader("Content-Encoding", "gzip")
    res.setHeader("Content-Type", "application/wasm")
  }
  next()
}
