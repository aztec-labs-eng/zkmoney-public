import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const origins = {
  dev: "https://wallet.dev.zk.money",
  staging: "https://wallet.staging.zk.money",
  production: "https://wallet.zk.money",
}

/** Validate the resolved Vite environment, including dotenv and process-env overrides. */
export function metricsBuildTarget(env, app, command = "build") {
  const environment = env.VITE_METRICS_ENVIRONMENT || "staging"
  if (!Object.hasOwn(origins, environment)) {
    throw new Error("VITE_METRICS_ENVIRONMENT must be dev, staging, or production")
  }
  if (command === "serve" && environment === "production") {
    throw new Error("Local development must use staging metrics")
  }
  if (app === "campaign" && environment === "production" && env.VITE_CAMPAIGN_ENV !== "prod") {
    throw new Error("Production campaign metrics require VITE_CAMPAIGN_ENV=prod")
  }
  const analyticsUrl = (
    env.VITE_ZKMONEY_API_URL || (app === "campaign" ? `${origins[environment]}/svc/usage` : "")
  ).replace(/\/$/, "")
  if (app === "campaign" && analyticsUrl === "/svc/usage") {
    throw new Error("Campaign metrics require an absolute wallet proxy URL")
  }
  // Playwright intercepts this reserved origin; publish checks still reject it.
  const testIngest =
    app === "wallet" && environment === "staging" && analyticsUrl === "http://analytics.e2e.invalid"
  if (analyticsUrl && analyticsUrl !== "/svc/usage" && !testIngest) {
    let url
    try {
      url = new URL(analyticsUrl)
    } catch {
      throw new Error("Invalid VITE_ZKMONEY_API_URL")
    }
    const local =
      environment === "staging" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (
      (!local && url.origin !== origins[environment]) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/svc/usage"
    ) {
      throw new Error(
        `Analytics URL must use the ${environment} wallet /svc/usage proxy${
          environment === "staging" ? " or a local /svc/usage proxy" : ""
        }`,
      )
    }
  }
  return { version: 1, app, environment, analyticsUrl }
}

/** The emitted target is also checked when a previously built artifact is deployed. */
export function metricsBuildPlugin(app) {
  let target
  return {
    name: "metrics-environment",
    configResolved(config) {
      // Only explicitly targeted wallet builds participate in hosted publish checks.
      // Other consumers of the wallet build keep their existing endpoint configuration.
      if (app === "wallet" && config.command === "build" && !config.env.VITE_METRICS_ENVIRONMENT) {
        return
      }
      target = metricsBuildTarget(config.env, app, config.command)
    },
    generateBundle() {
      if (!target) return
      this.emitFile({
        type: "asset",
        fileName: "metrics-target.json",
        source: JSON.stringify(target) + "\n",
      })
    },
  }
}

export function checkMetricsArtifact(file, slot) {
  if (!["staging", "prod", "production", "preview", "dev"].includes(slot))
    throw new Error("Unknown deployment slot")
  const expected = ["prod", "production"].includes(slot)
    ? "production"
    : slot === "dev"
    ? "dev"
    : "staging"
  if (!existsSync(file)) {
    throw new Error(
      "Metrics artifact missing: set VITE_METRICS_ENVIRONMENT to dev, staging, or production and rebuild",
    )
  }
  const target = JSON.parse(readFileSync(file, "utf8"))
  if (
    target.version !== 1 ||
    target.environment !== expected ||
    !["wallet", "campaign"].includes(target.app)
  ) {
    throw new Error(`Metrics artifact must target ${expected}`)
  }
  if (typeof target.analyticsUrl !== "string" || !target.analyticsUrl) {
    throw new Error("Published builds must have an analytics endpoint")
  }
  if (
    target.analyticsUrl !== "/svc/usage" &&
    new URL(target.analyticsUrl).origin !== origins[expected]
  ) {
    throw new Error("Published builds must use the selected hosted wallet proxy")
  }
  metricsBuildTarget(
    {
      VITE_METRICS_ENVIRONMENT: expected,
      VITE_CAMPAIGN_ENV: expected === "production" ? "prod" : expected,
      VITE_ZKMONEY_API_URL: target.analyticsUrl,
    },
    target.app,
  )
  return expected
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , file, slot] = process.argv
    console.log(`Metrics artifact: ${checkMetricsArtifact(file, slot)}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
