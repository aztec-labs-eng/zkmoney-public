"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { assertPackagingInputs } = require("./preflight-package")

// RFC 2606 reserved domains: this suite exercises the plumbing, not any real target.
const NODE_URL = "https://node.example.invalid"
const PAGE_HOSTNAME = "wallet.example.invalid"
const PASSKEY_RP_ID = "rp.example.invalid"

// A packageable tree, which each test then breaks in one way.
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-preflight-"))
  fs.mkdirSync(path.join(root, "web", "assets"), { recursive: true })
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.writeFileSync(path.join(root, "web", "index.html"), "<head></head>")
  fs.writeFileSync(
    path.join(root, "web", "build-target.json"),
    overrides.buildTarget ?? JSON.stringify({ VITE_DESKTOP_BUILD: "true" }),
  )
  fs.writeFileSync(path.join(root, "web", "assets", "walletBoot-abc.js"), `fetch("${NODE_URL}")`)
  const metadata = {
    builtAt: "2026-09-25T16:25:19.291Z",
    bakedNodeUrl: NODE_URL,
    pageHostname: PAGE_HOSTNAME,
    passkeyRpId: PASSKEY_RP_ID,
    ...overrides.metadata,
  }
  const generated = {
    hostname: PAGE_HOSTNAME,
    passkeyRpId: PASSKEY_RP_ID,
    ...overrides.generated,
  }
  fs.writeFileSync(path.join(root, "build-meta.json"), JSON.stringify(metadata))
  if (!overrides.omitGenerated) {
    fs.writeFileSync(path.join(root, "config", "generated.json"), JSON.stringify(generated))
  }
  return root
}

function withFixture(overrides, body) {
  const root = fixture(overrides)
  try {
    body(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test("accepts a complete tree", () => {
  withFixture({}, (root) => {
    assert.deepEqual(assertPackagingInputs(root), {
      pageHostname: PAGE_HOSTNAME,
      passkeyRpId: PASSKEY_RP_ID,
    })
  })
})

test("refuses a missing config/generated.json", () => {
  withFixture({ omitGenerated: true }, (root) => {
    assert.throws(() => assertPackagingInputs(root), /config\/generated\.json is missing/)
  })
})

test("refuses metadata predating pageHostname", () => {
  withFixture({ metadata: { pageHostname: undefined, passkeyRpId: undefined } }, (root) => {
    assert.throws(() => assertPackagingInputs(root), /no usable pageHostname/)
  })
})

test("refuses a launcher config that disagrees with the metadata", () => {
  withFixture(
    { generated: { hostname: "other.example.invalid", passkeyRpId: "other.example.invalid" } },
    (root) => {
      assert.throws(() => assertPackagingInputs(root), /differs from config\/generated\.json/)
    },
  )
})

test("refuses metadata describing a different build than the bundle", () => {
  withFixture({ metadata: { bakedNodeUrl: "https://other-node.example.invalid" } }, (root) => {
    assert.throws(() => assertPackagingInputs(root), /does not appear in web\//)
  })
})

for (const [label, buildTarget] of [
  ["without the desktop flag", JSON.stringify({})],
  ["with an empty desktop flag", JSON.stringify({ VITE_DESKTOP_BUILD: "" })],
  ["with the desktop flag off", JSON.stringify({ VITE_DESKTOP_BUILD: "false" })],
  ["with a boolean desktop flag", JSON.stringify({ VITE_DESKTOP_BUILD: true })],
]) {
  test(`refuses a bundle ${label}`, () => {
    withFixture({ buildTarget }, (root) => {
      assert.throws(() => assertPackagingInputs(root), /does not mark a desktop build/)
    })
  })
}

test("refuses a missing build-target.json", () => {
  withFixture({}, (root) => {
    fs.rmSync(path.join(root, "web", "build-target.json"))
    assert.throws(() => assertPackagingInputs(root), /web\/build-target\.json is missing/)
  })
})

test("refuses an unreadable build-target.json", () => {
  withFixture({ buildTarget: "{ not json" }, (root) => {
    assert.throws(() => assertPackagingInputs(root), /web\/build-target\.json is unreadable/)
  })
})

test("refuses a missing wallet bundle", () => {
  withFixture({}, (root) => {
    fs.rmSync(path.join(root, "web", "index.html"))
    assert.throws(() => assertPackagingInputs(root), /web\/index\.html is missing/)
  })
})
