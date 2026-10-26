// Copied into the v5 checkout's web-wallet package beside the adapter, and run from there, so the
// adapter resolves the v5 workspace exactly as that commit's wallet does. It keeps the parts of the
// wallet's vite config the PXE needs.
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { defineConfig, type Plugin } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"

const require = createRequire(import.meta.url)
const wallet = path.resolve(__dirname, "..")
// The adapter takes the Inbox binding the sdk's refund runtime takes, from the sdk's own dependency.
const sdkRequire = createRequire(path.resolve(wallet, "../sdk/package.json"))
const outDir = process.env.GENERATION_OUT_DIR
if (!outDir) throw new Error("GENERATION_OUT_DIR is required")
const pathRoots = process.env.GENERATION_PATH_ROOTS
if (!pathRoots) throw new Error("GENERATION_PATH_ROOTS is required")

/** The version of the installed package `name`, found from one of its exported subpaths. */
function installedVersion(name: string, subpath: string): string {
  const entry = require.resolve(`${name}/${subpath}`)
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const file = path.join(dir, "package.json")
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    if (manifest.name === name) return manifest.version
  }
  throw new Error(`No package.json for ${name}`)
}

// vite-plugin-node-polyfills#81: its bare shim specifiers do not resolve from other workspace
// packages' dist files under pnpm.
const shimResolveFix: Plugin = {
  name: "node-polyfills-shim-resolve-fix",
  resolveId(source, _importer, options) {
    if ((options as { scan?: boolean } | undefined)?.scan) return undefined
    if (/^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.test(source))
      return require.resolve(source).replace(/dist\/index\.cjs$/, "dist/index.js")
  },
}

// The sqlite3mc loader asks for these at runtime, relative to its worker chunk.
const sqliteRuntimeAssets: Plugin = {
  name: "sqlite-runtime-assets",
  apply: "build",
  generateBundle() {
    for (const file of ["sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) {
      this.emitFile({
        type: "asset",
        fileName: `assets/${file}`,
        source: readFileSync(require.resolve(`@aztec/sqlite3mc-wasm/vendor/jswasm/${file}`)),
      })
    }
  },
}

// The Noir artifacts embed the absolute paths of their sources. build.mjs names each build root and
// its fixed name. The chunks take the fixed names before Rollup hashes them, so the bundle does not
// depend on where it is built.
const fixedPaths: Plugin = {
  name: "generation-v5-fixed-paths",
  apply: "build",
  renderChunk(code) {
    const roots: [string, string][] = JSON.parse(pathRoots)
    const out = roots.reduce((text, [from, to]) => text.replaceAll(from, to), code)
    return out === code ? null : { code: out, map: null }
  },
}

export default defineConfig({
  root: wallet,
  base: "./",
  publicDir: false,
  define: {
    "process.env.LOG_LEVEL": JSON.stringify(process.env.PXE_LOG_LEVEL ?? "info"),
    "__AZTEC_VERSION__": JSON.stringify(installedVersion("@aztec/aztec.js", "fields")),
  },
  plugins: [
    nodePolyfills({ include: ["buffer", "assert", "util"] }),
    shimResolveFix,
    sqliteRuntimeAssets,
    fixedPaths,
  ],
  resolve: {
    alias: {
      "@crate-crypto/node-eth-kzg": path.resolve(wallet, "src/shims/node-eth-kzg.ts"),
      "@aztec/ethereum/contracts": sdkRequire.resolve("@aztec/ethereum/contracts"),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "index.ts"),
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "index.js" },
    },
  },
})
