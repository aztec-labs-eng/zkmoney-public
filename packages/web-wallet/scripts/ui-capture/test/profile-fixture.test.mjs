import assert from "node:assert/strict"
import { test } from "node:test"
import * as configClient from "@obsidion/config-client"
import * as oxide from "@obsidion/core/oxide"
import { captureFixtures, DEMO_PORTAL } from "../profile-fixture.mjs"

const manifestUrl = "http://127.0.0.1:5786/__ui-capture/oxide.json"

test("capture profile and endpoint follow the installed public schema", async () => {
  const fixture = captureFixtures(manifestUrl)
  assert.equal(configClient.configProfileSchema.safeParse(fixture.profile).success, true)
  const pointer = fixture.profile.versions[fixture.profile.current].oxide
  assert.equal(pointer.manifestUrl, manifestUrl)
  assert.equal(fixture.profile.network, "sandbox")
  if (fixture.kind === "legacy") {
    assert.deepEqual(Object.keys(pointer).sort(), ["expectedEntryTimestamp", "manifestUrl", "stack"])
    let fetched = false
    const warnings = []
    await configClient.checkOxideEntryPin(fixture.profile, async (url) => {
      assert.equal(url, manifestUrl); fetched = true
      return new Response(JSON.stringify(fixture.manifest), { status: 200 })
    }, (warning) => warnings.push(warning))
    assert.equal(fetched, true)
    assert.deepEqual(warnings, [])
  } else {
    assert.equal(fixture.kind, "portal")
    assert.deepEqual(Object.keys(pointer).sort(), ["manifestUrl", "portal"])
    assert.equal(pointer.portal, DEMO_PORTAL)
    const { tuple } = oxide.extractPinnedOxideEnvTuple(fixture.manifest, pointer)
    assert.equal(tuple.portal, DEMO_PORTAL)
    assert.equal(tuple.chainId, "31337")
    assert.equal(tuple.token, "0xb0de1000000000000000000000000000000b01d0")
    assert.throws(() => oxide.extractPinnedOxideEnvTuple(fixture.manifest, { portal: "0x" + "12".repeat(20) }), /portal/)
  }
})

test("invalid fixture URLs fail validation and calls do not share mutable data", () => {
  assert.throws(() => captureFixtures("not a URL"), /exactly one supported public schema variant/)
  const first = captureFixtures(manifestUrl)
  first.profile.profileId = "mutated"
  first.manifest.extra = "mutated"
  const second = captureFixtures(manifestUrl)
  assert.equal(second.profile.profileId, "ui-capture")
  assert.equal(second.manifest.extra, undefined)
})
