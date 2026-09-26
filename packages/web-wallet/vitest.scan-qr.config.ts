import { defineConfig } from "vitest/config"
import unitConfig from "./vitest.config"

export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    environment: "node",
    include: ["test/browser/scanQrCard.browser.tsx"],
  },
})
