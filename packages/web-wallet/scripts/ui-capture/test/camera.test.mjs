import assert from "node:assert/strict"
import { test } from "node:test"
import { loadChromium } from "../capture-support.mjs"
import { cameraFixtureOptions, cameraStep, installCameraFixture } from "../camera.mjs"
import path from "node:path"

const repo = path.resolve(import.meta.dirname, "../../../../..")

test("camera fixture rejects unsupported configuration", () => {
  assert.throws(() => cameraFixtureOptions({ state: "real" }))
  assert.throws(() => cameraFixtureOptions({ state: "live", payload: 7 }))
  assert.throws(() => cameraFixtureOptions({ state: "live", torch: "yes" }))
})

test("controlled camera permission, live stream and cleanup", async () => {
  const chromium = loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH)
  const browser = await chromium.launch({ headless: true })
  try {
    for (const state of ["denied", "unavailable", "pending", "live"]) {
      const context = await browser.newContext()
      await installCameraFixture(context, { state })
      const page = await context.newPage()
      await page.goto("about:blank")
      if (["denied", "unavailable"].includes(state)) {
        assert.equal(await page.evaluate(async () => {
          try { await navigator.mediaDevices.getUserMedia({ video: true }); return "unexpected" }
          catch (error) { return error.name }
        }), state === "denied" ? "NotAllowedError" : "NotReadableError")
      } else {
        await page.evaluate(() => { window.pendingCapture = navigator.mediaDevices.getUserMedia({ video: true }) })
        if (state === "pending") {
          assert.equal(await page.evaluate(() => window.__walletCaptureCamera.stats().pending), 1)
          await cameraStep(page, { operation: "grant" })
        }
        const active = await page.evaluate(async () => {
          window.stream = await window.pendingCapture
          return window.stream.getVideoTracks()[0].readyState
        })
        assert.equal(active, "live")
        await cameraStep(page, { operation: "payload", value: "@alice" })
        await assert.rejects(cameraStep(page, { operation: "assertStopped" }), /active tracks/)
        await page.evaluate(() => window.stream.getTracks().forEach((track) => track.stop()))
        const stats = await cameraStep(page, { operation: "assertStopped" })
        assert.equal(stats.stoppedTracks, 1)
      }
      await context.close()
    }
  } finally { await browser.close() }
})

test("controlled torch is opt-in and stopping its track clears the light", async () => {
  const browser = await loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  try {
    for (const torch of [false, true]) {
      const context = await browser.newContext()
      try {
        await installCameraFixture(context, { state: "live", torch })
        const page = await context.newPage()
        await page.goto("about:blank")
        const result = await page.evaluate(async () => {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true })
          const track = stream.getVideoTracks()[0]
          const capable = track.getCapabilities().torch === true
          if (capable) {
            for (const torch of [true, false, true]) await track.applyConstraints({ advanced: [{ torch }] })
          }
          const before = window.__walletCaptureCamera.stats()
          track.stop()
          return { capable, before, after: window.__walletCaptureCamera.stats() }
        })
        assert.equal(result.capable, torch)
        assert.deepEqual(result.before.torchChanges, torch ? [true, false, true] : [])
        assert.equal(result.before.activeTorchTracks, torch ? 1 : 0)
        assert.equal(result.after.activeTorchTracks, 0)
        assert.equal(result.after.activeTracks, 0)
      } finally { await context.close() }
    }
  } finally { await browser.close() }
})
