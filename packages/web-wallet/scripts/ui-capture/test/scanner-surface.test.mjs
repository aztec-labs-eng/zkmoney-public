import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "vite"
import react from "@vitejs/plugin-react"
import { cameraStep, installCameraFixture } from "../camera.mjs"
import { installCaptureGuard, loadChromium, verificationErrors } from "../capture-support.mjs"

const wallet = path.resolve(import.meta.dirname, "../../..")
const repo = path.resolve(wallet, "../..")
const insets = { top: 47, right: 6, bottom: 34, left: 6 }

async function assertRecoveredFocus(page, label) {
  const card = page.locator(".ww-modal.ww-scan")
  const close = page.getByRole("button", { name: "Close scanner", exact: true })
  const focus = await card.evaluate((node) => ({
    card: document.activeElement === node,
    close: document.activeElement === node.querySelector('[aria-label="Close scanner"]'),
  }))
  assert(focus.card || focus.close, `${label}: focus recovers to card or Close`)
  if (focus.card) await page.keyboard.press("Tab")
  assert.equal(await close.evaluate((node) => node === document.activeElement), true, `${label}: Tab from card reaches Close`)
  await page.keyboard.press("Shift+Tab")
  assert.equal(await card.evaluate((node) => node.contains(document.activeElement)), true, `${label}: reverse containment`)
  await page.keyboard.press("Tab")
  assert.equal(await close.evaluate((node) => node === document.activeElement), true, `${label}: end wraps to Close`)
  await page.keyboard.press("Tab")
  assert.equal(await card.evaluate((node) => node.contains(document.activeElement)), true, `${label}: forward containment`)
}

test("isolated scanner surface uses controlled media, persistent video and accessible recovery", { timeout: 180_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), "ult-785-isolated-surface-"))
  const report = { evidence: "isolated scanner UI; controlled Chromium media; parent resolution and Share endpoint are fixtures", cases: [], screenshots: [], files: {}, safeArea: insets }
  await build({
    configFile: false, root: wallet, publicDir: false, logLevel: "error",
    plugins: [react()],
    resolve: { alias: { "@obsidion/web-ds": path.join(repo, "packages/design-system/src/index.ts") } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { outDir: output, lib: { entry: path.join(wallet, "test/browser/scannerSurfaceHarness.tsx"), formats: ["es"], fileName: "surface", cssFileName: "surface" } },
    worker: { format: "es" },
  })
  const files = new Map()
  for (const name of await readdir(output, { recursive: true })) {
    if (!(await stat(path.join(output, name))).isFile()) continue
    const bytes = await readFile(path.join(output, name))
    files.set(`/${name}`, bytes)
    report.files[name] = createHash("sha256").update(bytes).digest("hex")
  }
  const server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp")
    response.setHeader("Permissions-Policy", "camera=(self), microphone=()")
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html")
      response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Isolated scanner surface</title><link rel="stylesheet" href="/surface.css"><div id="root"></div><script type="module" src="/surface.js"></script>')
      return
    }
    const bytes = files.get(request.url)
    response.writeHead(bytes ? 200 : 404, { "Content-Type": request.url.endsWith(".css") ? "text/css" : "text/javascript" })
    response.end(bytes || "")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = new URL(`http://127.0.0.1:${server.address().port}/`)
  let browser
  try {
    browser = await loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
    for (const viewport of [{ width: 390, height: 844 }, { width: 402, height: 879 }, { width: 390, height: 667 }]) {
      for (const colorScheme of ["dark", "light"]) {
        for (const state of ["pending", "denied", "unavailable", "live"]) {
          const context = await browser.newContext({ viewport, colorScheme, serviceWorkers: "block" })
          await installCaptureGuard(context, base, report)
          await installCameraFixture(context, { state })
          if (state === "live") await context.addInitScript(() => {
            const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
            navigator.mediaDevices.getUserMedia = async (constraints) => {
              const stream = await acquire(constraints)
              const track = stream.getVideoTracks()[0]
              track.getCapabilities = () => ({ torch: true })
              track.applyConstraints = async () => { if (window.__scannerRejectTorch) throw new Error("Fixture torch rejected") }
              return stream
            }
            navigator.mediaDevices.enumerateDevices = async () => [{ kind: "videoinput", deviceId: "fixture-front", label: "Front camera", groupId: "fixture", toJSON() {} }]
          })
          const page = await context.newPage()
          page.setDefaultTimeout(10_000)
          const name = `${state}-${viewport.width}x${viewport.height}-${colorScheme}`
          try {
            await page.goto(base.href)
            await page.evaluate((edges) => {
              for (const [edge, value] of Object.entries(edges)) document.documentElement.style.setProperty(`--ww-safe-area-${edge}`, `${value}px`)
            }, insets)
            await page.getByRole("button", { name: "Open isolated scanner", exact: true }).click()
            const modal = page.getByRole("dialog", { name: "Scan QR code", exact: true })
            await modal.waitFor()
            if (state === "live") await page.getByText("Point your camera at a wallet QR code.", { exact: true }).waitFor()
            else if (state === "pending") await page.getByText("Allow camera access to scan, or paste a code below.", { exact: true }).waitFor()
            else await page.getByRole("alert").waitFor()
            await page.evaluate(() => document.fonts.ready)
            await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" })
            report.screenshots.push(`${name}.png`)
            const bounds = await modal.evaluate((element) => {
              const box = element.getBoundingClientRect()
              const controls = [...element.querySelectorAll("button,input,select")].map((node) => {
                const rect = node.getBoundingClientRect()
                return { label: node.getAttribute("aria-label") || node.textContent?.trim() || "paste", top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
              })
              const frame = element.querySelector(".ww-scan__frame").getBoundingClientRect()
              const toolbar = element.querySelector(".ww-scan__toolbar").getBoundingClientRect()
              const preview = element.querySelector(".ww-scan__preview").getBoundingClientRect()
              return { top: box.top, bottom: box.bottom, width: box.width, scrollWidth: element.scrollWidth, controls,
                frame: { top: frame.top, bottom: frame.bottom }, toolbar: { top: toolbar.top, bottom: toolbar.bottom },
                preview: { top: preview.top, bottom: preview.bottom } }
            })
            assert(bounds.top >= -1 && bounds.bottom <= viewport.height + 1, `${name}: modal viewport bounds`)
            assert(bounds.scrollWidth <= viewport.width, `${name}: horizontal overflow`)
            assert(Math.abs(bounds.toolbar.top - (insets.top + 16)) <= 1, `${name}: safe-area inset applied once`)
            assert(bounds.frame.top >= bounds.toolbar.bottom && bounds.frame.top >= bounds.preview.top && bounds.frame.bottom <= bounds.preview.bottom, `${name}: all viewfinder corners remain visible`)
            for (const control of bounds.controls) {
              assert(control.top >= insets.top && control.bottom <= viewport.height - insets.bottom + 1, `${name}: ${control.label} vertical reachability`)
              assert(control.left >= insets.left && control.right <= viewport.width - insets.right, `${name}: ${control.label} horizontal reachability`)
            }
            const video = await page.locator("video").elementHandle()
            if (state === "live") {
              await page.getByRole("button", { name: "Turn flashlight on", exact: true }).click()
              await page.getByRole("button", { name: "Turn flashlight off", exact: true }).click()
              await page.evaluate(() => { window.__scannerRejectTorch = true })
              await page.getByRole("button", { name: "Turn flashlight on", exact: true }).focus()
              await page.keyboard.press("Enter")
              await page.getByRole("button", { name: "Turn flashlight on", exact: true }).waitFor({ state: "detached" })
              await assertRecoveredFocus(page, "torch failure")
              assert.equal(await page.evaluate(() => window.__walletCaptureCamera.stats().activeTracks), 1)
              await page.evaluate(() => { window.__scannerRejectTorch = false })
              await page.getByLabel("Camera", { exact: true }).focus()
              await page.getByLabel("Camera", { exact: true }).selectOption("fixture-front")
              await page.getByRole("button", { name: "Turn flashlight on", exact: true }).waitFor()
              await assertRecoveredFocus(page, "camera switch")
              await page.evaluate(() => {
                Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
                document.dispatchEvent(new Event("visibilitychange"))
              })
              await page.getByRole("button", { name: "Resume camera", exact: true }).waitFor()
              await cameraStep(page, { operation: "assertStopped" })
              await page.evaluate(() => {
                Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
                document.dispatchEvent(new Event("visibilitychange"))
              })
              await page.getByRole("button", { name: "Resume camera", exact: true }).focus()
              await page.keyboard.press("Enter")
              await page.getByText("Point your camera at a wallet QR code.", { exact: true }).waitFor()
              await assertRecoveredFocus(page, "resume")
              await page.keyboard.press("Tab")
              assert.equal(await modal.evaluate((node) => node.contains(document.activeElement)), true, "Tab remains inside scanner after recovery")
              await page.getByRole("button", { name: "Show my QR code", exact: true }).click()
              await cameraStep(page, { operation: "assertStopped" })
              await page.getByRole("button", { name: "Return to isolated scanner", exact: true }).click()
              await page.getByText("Point your camera at a wallet QR code.", { exact: true }).waitFor()
              await cameraStep(page, { operation: "payload", value: "invalid" })
              await page.getByRole("alert").waitFor()
              assert.equal(await page.getByLabel("Paste a link or @tag", { exact: true }).getAttribute("aria-invalid"), "false", "camera error does not invalidate paste field")
              await cameraStep(page, { operation: "assertStopped" })
              await cameraStep(page, { operation: "payload", value: "" })
              await page.getByRole("button", { name: "Try camera again", exact: true }).focus()
              await page.keyboard.press("Enter")
              await page.getByText("Point your camera at a wallet QR code.", { exact: true }).waitFor()
              await assertRecoveredFocus(page, "retry")
              await cameraStep(page, { operation: "payload", value: "@alice.zk.money" })
              await page.getByText("Isolated destination received", { exact: true }).waitFor()
            } else if (state === "pending") {
              await page.getByLabel("Paste a link or @tag", { exact: true }).fill("invalid")
              await page.getByRole("button", { name: "Continue", exact: true }).click()
              await page.getByRole("alert").waitFor()
              assert.equal(await video.evaluate((node) => node === document.querySelector("video")), true)
              assert.equal(await page.getByLabel("Paste a link or @tag", { exact: true }).getAttribute("aria-invalid"), "true", "manual error invalidates paste field")
              if (colorScheme === "dark") {
                await page.screenshot({ path: path.join(output, `${name}-invalid.png`), animations: "disabled" })
                report.screenshots.push(`${name}-invalid.png`)
              }
              await page.getByLabel("Paste a link or @tag", { exact: true }).fill("@alice")
              await page.getByRole("button", { name: "Continue", exact: true }).click()
              await page.getByText("Isolated destination received", { exact: true }).waitFor()
              await cameraStep(page, { operation: "grant" })
            } else {
              assert.equal(await page.getByRole("button", { name: "Turn flashlight on", exact: true }).count(), 0)
              await page.getByRole("button", { name: "Close scanner", exact: true }).click()
              assert.equal(await page.getByRole("button", { name: "Open isolated scanner", exact: true }).evaluate((node) => node === document.activeElement), true)
            }
            await page.waitForFunction(() => window.__walletCaptureCamera.stats().activeTracks === 0)
            const stats = await cameraStep(page, { operation: "assertStopped" })
            const events = await page.evaluate(() => window.__scannerSurfaceEvents)
            assert.equal(events.filter((event) => event.type === "destination").length, ["live", "pending"].includes(state) ? 1 : 0)
            report.cases.push({ name, viewport, colorScheme, state, bounds, stats, events, passed: true })
          } catch (error) {
            await page.screenshot({ path: path.join(output, `${name}-failure.png`), animations: "disabled" }).catch(() => {})
            throw error
          } finally { await context.close() }
        }
      }
    }
    // A reduced CSS viewport checks scrolling only; it does not simulate a device keyboard.
    const context = await browser.newContext({ viewport: { width: 390, height: 360 }, colorScheme: "dark", serviceWorkers: "block" })
    await installCaptureGuard(context, base, report)
    await installCameraFixture(context, { state: "denied" })
    const page = await context.newPage()
    try {
      await page.goto(base.href)
      await page.evaluate((edges) => {
        for (const [edge, value] of Object.entries(edges)) document.documentElement.style.setProperty(`--ww-safe-area-${edge}`, `${value}px`)
      }, insets)
      await page.getByRole("button", { name: "Open isolated scanner", exact: true }).click()
      await page.getByRole("alert").waitFor()
      const field = page.getByLabel("Paste a link or @tag", { exact: true })
      await field.fill("@alice")
      const submit = page.getByRole("button", { name: "Continue", exact: true })
      await submit.scrollIntoViewIfNeeded()
      const close = page.getByRole("button", { name: "Close scanner", exact: true })
      const closeBounds = await close.boundingBox()
      const submitBounds = await submit.boundingBox()
      assert(closeBounds.y >= insets.top && closeBounds.y + closeBounds.height < submitBounds.y, "reduced height keeps exit accessible above form")
      assert(submitBounds.y + submitBounds.height <= 360 - insets.bottom, "reduced height form stays clear of bottom inset")
      const screenshot = "denied-390x360-dark-scrolled.png"
      await page.screenshot({ path: path.join(output, screenshot), animations: "disabled" })
      report.screenshots.push(screenshot)
      await page.keyboard.press("Escape")
      await page.getByRole("dialog", { name: "Scan QR code", exact: true }).waitFor({ state: "detached" })
      assert.equal(await page.getByRole("button", { name: "Open isolated scanner", exact: true }).evaluate((node) => node === document.activeElement), true)
      const stats = await cameraStep(page, { operation: "assertStopped" })
      report.cases.push({ name: "reduced CSS height scroll and Escape", viewport: { width: 390, height: 360 }, closeBounds, submitBounds, stats, passed: true })
    } finally { await context.close() }
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2))
    console.info(`Isolated scanner surface evidence: ${output}`)
  }
})
