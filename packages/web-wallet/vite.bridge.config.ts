import { assertWebPasskeyBuild } from "@obsidion/passkey-web"
import { defineConfig, loadEnv, type Plugin } from "vite"
import { assertCampaignEnv } from "./src/config/campaignOrigin"

// The bridge page has to load behind a basic-auth gate that exempts exactly one path, and inside a
// frame that cannot answer a 401. So it ships as one file: this build inlines its only script into
// the page and drops the chunk, and `scripts/assert-bridge-standalone.mjs` proves nothing external
// is left. It runs after the main build into the same `dist/`, touching nothing else there.
const inlineScripts: Plugin = {
  name: "bridge-inline-scripts",
  apply: "build",
  enforce: "post",
  generateBundle(_options, bundle) {
    for (const [name, asset] of Object.entries(bundle)) {
      if (asset.type !== "asset" || !name.endsWith(".html")) continue
      const html =
        typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source)
      asset.source = html.replace(
        /<script type="module"[^>]*\ssrc="\/?([^"]+)"[^>]*><\/script>/g,
        (_tag, file: string) => {
          const chunk = bundle[file]
          if (!chunk || chunk.type !== "chunk") throw new Error(`bridge: no chunk for ${file}`)
          delete bundle[file]
          return `<script type="module">${chunk.code}</script>`
        },
      )
    }
  },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_")
  assertCampaignEnv(env)
  assertWebPasskeyBuild(env)
  return {
    plugins: [inlineScripts],
    build: {
      outDir: "dist",
      emptyOutDir: false,
      modulePreload: false,
      rollupOptions: { input: "bridge.html", output: { inlineDynamicImports: true } },
    },
  }
})
