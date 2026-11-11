import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

// Every spec in its own in-process E2E world (e2e/support/test.ts) rather than against one shared sandbox: no stack, no
// service process, nothing shared between tests, so they all run at once. Each worker serves the wallet build from
// dist/ on a port of its own (its `baseURL`). Run through scripts/e2e-light.sh, which generates the world snapshot and
// builds the wallet.

export default defineConfig({
  ...base,
  globalSetup: undefined,
  webServer: undefined,
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 16),
  maxFailures: 0,
  // Each world is its own chain, so nothing orders the projects any more.
  projects: [{ name: "wallet", testIgnore: [/migration\//] }],
  use: {
    ...base.use,
    // Recording costs every test, pass or fail: a trace keeps each response body (the whole wallet build per page)
    // and video encodes every frame. Rerun a failure with E2E_RECORD=1 to get both.
    trace: process.env.E2E_RECORD ? "retain-on-failure" : "off",
    video: process.env.E2E_RECORD ? "retain-on-failure" : "off",
    // A lean headless Chromium, since every test runs its own: no GPU process (the wallet draws nothing a CPU
    // rasterizer cannot), one raster thread, and none of the browser's own background services.
    launchOptions: {
      ...base.use?.launchOptions,
      args: [
        ...(base.use?.launchOptions?.args ?? []),
        "--disable-gpu",
        "--num-raster-threads=1",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider",
      ],
    },
  },
})
