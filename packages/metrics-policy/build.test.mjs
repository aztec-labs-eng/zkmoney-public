import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { checkMetricsArtifact, metricsBuildPlugin, metricsBuildTarget } from "./build.mjs"

test("production build mode alone never selects production metrics", () => {
  assert.equal(
    metricsBuildTarget({ MODE: "production", PROD: true }, "campaign").environment,
    "staging",
  )
  assert.equal(metricsBuildTarget({}, "wallet").analyticsUrl, "")
  assert.equal(
    metricsBuildTarget({}, "campaign").analyticsUrl,
    "https://wallet.staging.zk.money/svc/usage",
  )
})

test("the explicit deployment target controls hosted destinations", () => {
  assert.equal(
    metricsBuildTarget({ VITE_METRICS_ENVIRONMENT: "dev" }, "campaign").analyticsUrl,
    "https://wallet.dev.zk.money/svc/usage",
  )
  assert.equal(
    metricsBuildTarget(
      { VITE_METRICS_ENVIRONMENT: "production", VITE_ZKMONEY_API_URL: "/svc/usage" },
      "wallet",
    ).environment,
    "production",
  )
  assert.equal(
    metricsBuildTarget(
      { VITE_METRICS_ENVIRONMENT: "production", VITE_CAMPAIGN_ENV: "prod" },
      "campaign",
    ).analyticsUrl,
    "https://wallet.zk.money/svc/usage",
  )
  assert.doesNotThrow(() =>
    metricsBuildTarget({ VITE_ZKMONEY_API_URL: "http://localhost:5173/svc/usage" }, "wallet"),
  )
})

test("dev artifacts use the dev wallet proxy", () => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-dev-"))
  const file = join(dir, "metrics-target.json")
  try {
    writeFileSync(
      file,
      JSON.stringify(metricsBuildTarget({ VITE_METRICS_ENVIRONMENT: "dev" }, "campaign")),
    )
    assert.equal(checkMetricsArtifact(file, "dev"), "dev")
    assert.throws(() => checkMetricsArtifact(file, "staging"))
    assert.throws(() =>
      metricsBuildTarget(
        {
          VITE_METRICS_ENVIRONMENT: "dev",
          VITE_ZKMONEY_API_URL: "https://wallet.staging.zk.money/svc/usage",
        },
        "campaign",
      ),
    )
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("campaign pings cannot target a nonexistent same-origin proxy", () => {
  assert.throws(
    () => metricsBuildTarget({ VITE_ZKMONEY_API_URL: "/svc/usage" }, "campaign"),
    /absolute/,
  )
})

test("non-production builds cannot use a production proxy or disguised override", () => {
  for (const url of [
    "https://wallet.zk.money/svc/usage",
    "//wallet.zk.money/svc/usage",
    "https://wallet.staging.zk.money.evil/svc/usage",
    "https://wallet.staging.zk.money/svc/usage?tag=private",
    "https://user:password@wallet.staging.zk.money/svc/usage",
  ]) {
    assert.throws(() => metricsBuildTarget({ VITE_ZKMONEY_API_URL: url }, "wallet"))
  }
  assert.throws(() =>
    metricsBuildTarget(
      {
        VITE_METRICS_ENVIRONMENT: "production",
        VITE_ZKMONEY_API_URL: "https://wallet.staging.zk.money/svc/usage",
      },
      "wallet",
    ),
  )
  assert.throws(() => metricsBuildTarget({ VITE_METRICS_ENVIRONMENT: "prod" }, "wallet"))
  assert.throws(() =>
    metricsBuildTarget({ VITE_METRICS_ENVIRONMENT: "production" }, "wallet", "serve"),
  )
})

test("a cached production artifact cannot be deployed as a preview", () => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-build-"))
  const file = join(dir, "metrics-target.json")
  try {
    writeFileSync(
      file,
      JSON.stringify(
        metricsBuildTarget(
          { VITE_METRICS_ENVIRONMENT: "production", VITE_ZKMONEY_API_URL: "/svc/usage" },
          "wallet",
        ),
      ),
    )
    assert.equal(checkMetricsArtifact(file, "prod"), "production")
    assert.throws(() => checkMetricsArtifact(file, "preview"))
    assert.throws(() => checkMetricsArtifact(file, "prodd"))
    writeFileSync(file, JSON.stringify(metricsBuildTarget({}, "campaign")))
    assert.equal(checkMetricsArtifact(file, "preview"), "staging")
    assert.throws(() => checkMetricsArtifact(file, "production"))
    writeFileSync(
      file,
      JSON.stringify(
        metricsBuildTarget({ VITE_ZKMONEY_API_URL: "http://localhost:5173/svc/usage" }, "wallet"),
      ),
    )
    assert.throws(() => checkMetricsArtifact(file, "staging"), /hosted wallet proxy/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("Playwright's reserved ingest works in staging tests but cannot be published", () => {
  const env = {
    VITE_METRICS_ENVIRONMENT: "staging",
    VITE_ZKMONEY_API_URL: "http://analytics.e2e.invalid",
  }
  for (const command of ["build", "serve"]) {
    assert.equal(metricsBuildTarget(env, "wallet", command).analyticsUrl, env.VITE_ZKMONEY_API_URL)
  }
  assert.throws(() =>
    metricsBuildTarget({ ...env, VITE_METRICS_ENVIRONMENT: "production" }, "wallet"),
  )
  assert.throws(() => metricsBuildTarget(env, "campaign"))
  assert.throws(() =>
    metricsBuildTarget({ ...env, VITE_ZKMONEY_API_URL: "http://other.invalid" }, "wallet"),
  )
  const dir = mkdtempSync(join(tmpdir(), "metrics-e2e-"))
  const file = join(dir, "metrics-target.json")
  try {
    assert.throws(() => checkMetricsArtifact(file, "preview"), /VITE_METRICS_ENVIRONMENT.*rebuild/)
    writeFileSync(file, JSON.stringify(metricsBuildTarget(env, "wallet")))
    assert.throws(() => checkMetricsArtifact(file, "preview"), /hosted wallet proxy/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("wallet builds without a metrics target keep their endpoint but cannot be published", () => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-untargeted-"))
  const file = join(dir, "metrics-target.json")
  const env = { VITE_ZKMONEY_API_URL: "https://configured.example/v1/usage" }
  try {
    const plugin = metricsBuildPlugin("wallet")
    plugin.configResolved({ env, command: "build" })
    plugin.generateBundle.call({
      emitFile(asset) {
        writeFileSync(join(dir, asset.fileName), asset.source)
      },
    })
    assert.equal(env.VITE_ZKMONEY_API_URL, "https://configured.example/v1/usage")
    for (const slot of ["staging", "prod", "preview"]) {
      assert.throws(() => checkMetricsArtifact(file, slot), /VITE_METRICS_ENVIRONMENT.*rebuild/)
    }
    assert.throws(
      () =>
        metricsBuildPlugin("wallet").configResolved({
          env: { ...env, VITE_METRICS_ENVIRONMENT: "staging" },
          command: "build",
        }),
      /Analytics URL/,
    )
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("targeted wallet builds and default campaign builds emit validated publish metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-targeted-"))
  const file = join(dir, "metrics-target.json")
  try {
    for (const [app, env, slot] of [
      [
        "wallet",
        { VITE_METRICS_ENVIRONMENT: "staging", VITE_ZKMONEY_API_URL: "/svc/usage" },
        "staging",
      ],
      [
        "wallet",
        { VITE_METRICS_ENVIRONMENT: "production", VITE_ZKMONEY_API_URL: "/svc/usage" },
        "prod",
      ],
      ["campaign", {}, "staging"],
    ]) {
      const plugin = metricsBuildPlugin(app)
      plugin.configResolved({ env, command: "build" })
      plugin.generateBundle.call({
        emitFile(asset) {
          writeFileSync(join(dir, asset.fileName), asset.source)
        },
      })
      assert.equal(checkMetricsArtifact(file, slot), slot === "prod" ? "production" : "staging")
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})
