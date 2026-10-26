import { readFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"
import { dist as v5Dist, pinnedManifest, readBundle } from "@obsidion/generation-v5/check"

/** Each source generation's bundle, served at `generations/v<major>/`. */
const GENERATIONS = [{ major: "5", dist: v5Dist }]

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
}

/**
 * Emits and serves the source generation bundles. A build without one cannot read that
 * generation's rollup. `REQUIRE_SOURCE_GENERATIONS=true` makes a missing or unpinned bundle a build
 * failure.
 */
export function sourceGenerations(): Plugin {
  const load = () =>
    GENERATIONS.flatMap(({ major, dist }) => {
      const required = process.env.REQUIRE_SOURCE_GENERATIONS === "true"
      const bundle = readBundle(dist)
      if (!bundle) {
        const missing = `The Aztec v${major} source generation is not built at ${dist}`
        if (required) throw new Error(missing)
        console.warn(`${missing}: this build cannot read Aztec v${major} rollups`)
        return []
      }
      if (bundle.manifestSha256 !== pinnedManifest()) {
        const unpinned = `The Aztec v${major} bundle at ${dist} is not the one pin.json names`
        if (required) throw new Error(unpinned)
        console.warn(`${unpinned}: serving it for this local build`)
      }
      return [{ major, files: bundle.files }]
    })
  return {
    name: "obsidion-source-generations",
    configureServer(server) {
      const bundles = load()
      server.middlewares.use((req, res, next) => {
        const match = /^\/generations\/v(\d+)\/([^?]+)/.exec(req.url ?? "")
        const file = match && bundles.find((b) => b.major === match[1])?.files.get(match[2]!)
        if (!file) return next()
        // The page's cross-origin isolation refuses a worker served without it.
        for (const [name, value] of Object.entries(server.config.server.headers ?? {}))
          res.setHeader(name, value as string)
        res.setHeader(
          "Content-Type",
          CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        )
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const { major, files } of load())
        for (const [name, file] of files)
          this.emitFile({
            type: "asset",
            fileName: `generations/v${major}/${name}`,
            source: readFileSync(file),
          })
    },
  }
}
