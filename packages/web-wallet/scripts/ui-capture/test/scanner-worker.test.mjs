import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "vite"
import { cameraStep, installCameraFixture } from "../camera.mjs"
import { installCaptureGuard, loadChromium, verificationErrors } from "../capture-support.mjs"

const wallet = path.resolve(import.meta.dirname, "../../..")
const repo = path.resolve(wallet, "../..")

test("bundled scanner worker reads controlled media and releases late permission streams", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "ult-785-worker-"))
  const report = { cases: [], workerRequests: [], files: {} }
  await build({
    configFile: false,
    root: wallet,
    publicDir: false,
    logLevel: "error",
    build: {
      outDir: output,
      lib: { entry: path.join(wallet, "src/features/scan/cameraSession.ts"), formats: ["es"], fileName: "scanner" },
    },
    worker: { format: "es" },
  })
  const files = new Map()
  for (const name of await readdir(output, { recursive: true })) {
    if (!name.endsWith(".js")) continue
    const bytes = await readFile(path.join(output, name))
    files.set(`/${name}`, bytes)
    report.files[name] = createHash("sha256").update(bytes).digest("hex")
  }
  assert(files.has("/scanner.js"))
  assert([...files.keys()].some((name) => name.includes("qrDecoder.worker")))
  const server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp")
    response.setHeader("Permissions-Policy", "camera=(self), microphone=()")
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html")
      response.end('<!doctype html><title>Scanner worker test</title><video autoplay muted playsinline></video>')
      return
    }
    const bytes = files.get(request.url)
    response.writeHead(bytes ? 200 : 404, { "Content-Type": "text/javascript" })
    response.end(bytes || "")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = new URL(`http://127.0.0.1:${server.address().port}/`)
  const browser = await loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  try {
    for (const state of ["live", "pending"]) {
      const context = await browser.newContext({ serviceWorkers: "block" })
      await installCaptureGuard(context, base, report)
      await installCameraFixture(context, { state })
      context.on("request", (request) => {
        if (request.url().includes("qrDecoder.worker")) report.workerRequests.push(request.url())
      })
      const page = await context.newPage()
      await page.goto(base.href)
      await page.evaluate(async () => {
        const { CameraSession } = await import("/scanner.js")
        window.results = []
        window.states = []
        window.session = new CameraSession({
          video: document.querySelector("video"),
          mediaDevices: navigator.mediaDevices,
          onState: (value) => window.states.push(value),
          onPayload: (value) => window.results.push(value),
        })
        void window.session.start()
      })
      if (state === "live") {
        await page.waitForFunction(() => window.states.some((value) => value.kind === "active"))
        assert.equal(await page.evaluate(() => window.crossOriginIsolated), true)
        assert.deepEqual(await page.evaluate(() => window.results), [])
        await cameraStep(page, { operation: "payload", value: "@alice.zk.money" })
        try {
          await page.waitForFunction(() => window.results.length === 1, null, { timeout: 5_000 })
        } catch (error) {
          report.diagnostics = await page.evaluate(() => ({ states: window.states, results: window.results, stats: window.__walletCaptureCamera.stats(), video: { width: document.querySelector("video").videoWidth, height: document.querySelector("video").videoHeight } }))
          await page.screenshot({ path: path.join(output, "failure.png") })
          throw error
        }
        assert.deepEqual(await page.evaluate(() => window.results), ["@alice.zk.money"])
      } else {
        await page.waitForFunction(() => window.__walletCaptureCamera.stats().pending === 1)
        await page.evaluate(() => window.session.stop())
        await cameraStep(page, { operation: "grant" })
        await page.waitForFunction(() => window.__walletCaptureCamera.stats().activeTracks === 0)
        assert.deepEqual(await page.evaluate(() => window.results), [])
        assert.equal(await page.evaluate(() => document.querySelector("video").srcObject), null)
      }
      const stats = await cameraStep(page, { operation: "assertStopped" })
      assert.equal(stats.stoppedTracks, 1)
      report.cases.push({ state, stats, passed: true })
      await context.close()
    }
    assert.equal(report.workerRequests.length, 1)
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2))
    console.info(`Scanner worker evidence: ${output}`)
  }
})
