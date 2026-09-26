import { defineConfig } from "vitest/config"
import unitConfig from "./vitest.config"

/** Explicit browser corpus; ordinary unit tests do not require a Chromium installation. */
export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    environment: "node",
    include: ["test/gradientQrCard.browser.tsx"],
  },
})
