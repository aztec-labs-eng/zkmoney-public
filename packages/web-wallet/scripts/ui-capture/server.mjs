import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { captureFixtures } from "./profile-fixture.mjs"
import { flowFixturePlugin } from "./flow-fixtures.mjs"

export const walletDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export const profile = captureFixtures("http://oxide.ui-capture.invalid/sandbox.json").profile

export async function startCaptureServer(port) {
  // The capture process owns its environment. Never inherit network profiles or local .env files.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VITE_") || key.startsWith("BASIC_AUTH_")) delete process.env[key]
  }
  const origin = `http://127.0.0.1:${port}`
  const { profile: captureProfile, manifest } = captureFixtures(`${origin}/__ui-capture/oxide.json`)
  Object.assign(process.env, {
    VITE_NETWORK: "sandbox",
    VITE_CONFIG_PROFILE_URL: `${origin}/__ui-capture/profile.json`,
    VITE_CONFIG_EXPECTED_PROFILE_ID: profile.profileId,
  })
  const server = await createServer({
    root: walletDir,
    configFile: path.join(walletDir, "vite.config.ts"),
    envDir: false,
    mode: "ui-capture",
    cacheDir: path.join(walletDir, "node_modules/.vite-ui-capture"),
    logLevel: "warn",
    optimizeDeps: { entries: ["src/main.tsx", "src/walletBoot.tsx", "src/dev/seedDemo.ts"] },
    server: {
      host: "127.0.0.1", port, strictPort: true, open: false,
      warmup: { clientFiles: ["./src/main.tsx", "./src/walletBoot.tsx", "./src/dev/seedDemo.ts"] },
    },
    plugins: [flowFixturePlugin(walletDir), {
      name: "wallet-ui-capture",
      configResolved(config) {
        // Browser interception is the first guard; remove Vite's service proxies as well.
        config.server.proxy = {}
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url, origin).pathname
          if (pathname === "/__ui-capture/profile.json") {
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify(captureProfile))
          } else if (pathname === "/__ui-capture/oxide.json") {
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify(manifest))
          } else if (pathname === "/svc" || pathname.startsWith("/svc/")) {
            res.statusCode = 503
            res.end("Service requests are disabled during UI capture")
          } else next()
        })
      },
    }],
  })
  try {
    await server.listen()
    return { server, origin }
  } catch (error) {
    await server.close()
    throw error
  }
}
