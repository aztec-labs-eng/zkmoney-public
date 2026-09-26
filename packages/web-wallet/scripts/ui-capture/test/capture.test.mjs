import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium } from "@playwright/test"
import { PHONE_PRESETS, selectedViewports } from "../plan.mjs"
import { externalOutputDir, outputDirectory, outputPath, writeOutputFile } from "../output.mjs"
import { installCaptureGuard, verificationErrors, localBaseUrl } from "../capture-support.mjs"
import { startVideo, videoDimensions } from "../video.mjs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${server.address().port}`
}
const close = (server) => new Promise((resolve) => server.close(resolve))

test("phone batch includes the short viewport and rejects ambiguous dimensions", () => {
  assert.deepEqual(selectedViewports("all").map(({ width, height }) => `${width}x${height}`), PHONE_PRESETS)
  assert.deepEqual(selectedViewports(undefined, "1280x832"), [{ width: 1280, height: 832 }])
  assert.throws(() => selectedViewports("390x844", "1280x832"))
  assert.throws(() => selectedViewports("phone"))
})

test("invalid source destinations create no directories, including through ancestor symlinks", async () => {
  assert.throws(() => outputPath("/tmp/capture", "../source.png"))
  assert.throws(() => outputPath("/tmp/capture", "/tmp/elsewhere.png"))
  const directory = await mkdtemp(path.join(tmpdir(), "capture-path-test-"))
  const source = path.join(directory, "source")
  try {
    await mkdir(source)
    await symlink(source, path.join(directory, "source-link"))
    for (const ancestor of [source, path.join(directory, "source-link")]) {
      await assert.rejects(externalOutputDir(path.join(ancestor, "new/output"), source), /outside the repository/)
      await assert.rejects(access(path.join(source, "new")))
    }
    const output = await externalOutputDir(path.join(directory, "new/output"), source)
    await writeOutputFile(output, "report.json", "report")
    await assert.rejects(externalOutputDir(output, source), /empty directory/)
    assert.equal(await readFile(path.join(output, "report.json"), "utf8"), "report")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("generated files reject preset, nested-directory and file symlinks without overwriting targets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capture-symlink-test-"))
  const source = path.join(directory, "source")
  const output = path.join(directory, "output")
  try {
    await mkdir(source)
    await mkdir(output)
    const original = path.join(source, "original")
    await writeFile(original, "unchanged")
    await symlink(source, path.join(output, "390x844"))
    await assert.rejects(externalOutputDir(output, source), /empty directory/)
    await assert.rejects(outputDirectory(output, "390x844"), /symlink/)
    await assert.rejects(writeOutputFile(output, "390x844/shot.png", "invalid"), /symlink/)
    await assert.rejects(access(path.join(source, "shot.png")))
    const run = await outputDirectory(output, "390x667")
    await symlink(source, path.join(run, "nested"))
    await assert.rejects(writeOutputFile(run, "nested/shot.png", "invalid"), /symlink/)
    for (const file of ["shot.png", "failure.png", "report.json", "recording.webm"]) {
      await symlink(original, path.join(run, file))
      await assert.rejects(writeOutputFile(run, file, "invalid"), { code: "EEXIST" })
    }
    assert.equal(await readFile(original, "utf8"), "unchanged")
    await writeOutputFile(run, "clean/shot.png", "first capture")
    await assert.rejects(writeOutputFile(run, "clean/shot.png", "replacement"), { code: "EEXIST" })
    assert.equal(await readFile(path.join(run, "clean/shot.png"), "utf8"), "first capture")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("guard prevents external, proxied, redirected and websocket requests from reaching services", async () => {
  let serviceHits = 0
  const service = createServer((_req, res) => { serviceHits++; res.end("unexpected") })
  const serviceOrigin = await listen(service)
  const localHits = []
  const local = createServer((req, res) => {
    localHits.push(req.url)
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `${serviceOrigin}/redirected` })
      res.end()
    } else {
      res.setHeader("Content-Type", "text/html")
      res.end("<!doctype html><title>Capture guard</title><p>Local page</p>")
    }
  })
  const origin = await listen(local)
  const browser = await chromium.launch()
  const report = {}
  try {
    const context = await browser.newContext({ serviceWorkers: "block" })
    await installCaptureGuard(context, localBaseUrl(origin), report)
    const page = await context.newPage()
    await page.goto(origin)
    await page.evaluate(async (external) => {
      await Promise.all([
        fetch(`${external}/direct`).catch(() => {}),
        fetch("/svc/account/test").catch(() => {}),
        fetch("/redirect").catch(() => {}),
        new Promise((resolve) => {
          const socket = new WebSocket(`${external.replace("http:", "ws:")}/socket`)
          socket.onclose = resolve
          socket.onerror = resolve
        }),
      ])
    }, serviceOrigin)
    assert.equal(serviceHits, 0)
    assert.equal(localHits.includes("/svc/account/test"), false)
    assert.equal(report.externalRequests.length, 2)
    assert.equal(report.proxyRequests.length, 1)
    assert.equal(report.blockedRedirects.length, 1)
    assert.equal(report.blockedWebSockets.length, 1)
    assert.ok(verificationErrors(report).length)
    await context.close()
  } finally {
    await browser.close()
    await Promise.all([close(local), close(service)])
  }
})

test("recordings preserve decoded bottom and right edge pixels at phone and odd-width viewports", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capture-video-test-"))
  const browser = await chromium.launch()
  try {
    for (const viewport of [...selectedViewports("all"), { width: 391, height: 667 }]) {
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      await page.setContent('<style>body { margin: 0; height: 2000px; background: #123456 } footer { position:fixed; bottom:0; height:1px; width:100%; background:red } aside { position:fixed; top:0; right:0; height:100%; width:1px; background:lime }</style><footer></footer><aside></aside>')
      const video = await startVideo(page, viewport)
      await page.screenshot({ fullPage: true })
      await page.evaluate(() => window.scrollTo(0, 500))
      await page.waitForTimeout(250)
      const output = await outputDirectory(directory, `${viewport.width}x${viewport.height}`)
      const result = await video.finish(output)
      assert.deepEqual(await videoDimensions(result.file), viewport)
      assert.equal(result.method, "viewport-png")
      assert.ok(result.frames >= 2)
      const { stdout: pixels } = await exec("ffmpeg", [
        "-v", "error", "-sseof", "-0.1", "-i", result.file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ], { encoding: "buffer", maxBuffer: viewport.width * viewport.height * 4 })
      assert.equal(pixels.length, viewport.width * viewport.height * 3)
      const near = (x, y, expected) => {
        const index = (y * viewport.width + x) * 3
        const actual = [...pixels.subarray(index, index + 3)]
        assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 3), `Pixel ${x},${y} was ${actual}, expected ${expected}`)
      }
      near(Math.floor(viewport.width / 2), viewport.height - 1, [255, 0, 0])
      near(viewport.width - 1, Math.floor(viewport.height / 2), [0, 255, 0])
      near(Math.floor(viewport.width / 2), viewport.height - 2, [18, 52, 86])
      await context.close()
    }
  } finally {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("recording retries only transient inactive-page errors, with a bounded and reported count", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capture-video-retry-"))
  const browser = await chromium.launch()
  try {
    for (const kind of ["transient", "persistent", "other"]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 667 } })
      const page = await context.newPage()
      const createSession = context.newCDPSession.bind(context)
      let requests = 0
      context.newCDPSession = async (target) => {
        const session = await createSession(target)
        const send = session.send.bind(session)
        session.send = async (method, params) => {
          if (method === "Page.captureScreenshot") {
            requests++
            if (kind !== "transient" || requests === 1) {
              throw new Error(kind === "other" ? "Unexpected capture failure" : "Protocol error (Page.captureScreenshot): Not attached to an active page")
            }
          }
          return send(method, params)
        }
        return session
      }
      if (kind === "transient") {
        const video = await startVideo(page, { width: 390, height: 667 })
        const output = await outputDirectory(directory, kind)
        const result = await video.finish(output)
        assert.equal(result.captureRetries, 1)
        assert.deepEqual(await videoDimensions(result.file), { width: 390, height: 667 })
      } else {
        await assert.rejects(startVideo(page, { width: 390, height: 667 }))
        assert.equal(requests, kind === "persistent" ? 10 : 1)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("a closed recording page fails without publishing a partial video", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capture-video-failure-"))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 667 } })
    const video = await startVideo(page, { width: 390, height: 667 })
    await page.close()
    await assert.rejects(video.finish(directory), /closed/)
    await assert.rejects(access(path.join(directory, "recording.webm")))
    await assert.rejects(startVideo(page, { width: 390, height: 667 }))
  } finally {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("guard retries a reset local GET without permitting redirects or service requests", async () => {
  let attempts = 0
  const local = createServer((req, res) => {
    if (req.url === "/asset" && ++attempts === 1) { req.socket.destroy(); return }
    res.end("local response")
  })
  const origin = await listen(local)
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ serviceWorkers: "block" })
    const report = {}
    await installCaptureGuard(context, localBaseUrl(origin), report)
    const page = await context.newPage()
    await page.goto(`${origin}/asset`)
    assert.equal(await page.locator("body").innerText(), "local response")
    assert.equal(attempts, 2)
    assert.deepEqual(verificationErrors(report), [])
    await context.close()
  } finally { await browser.close(); await close(local) }
})
