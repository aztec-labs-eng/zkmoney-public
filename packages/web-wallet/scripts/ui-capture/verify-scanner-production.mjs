import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { installCameraFixture } from "./camera.mjs"
import { installCaptureGuard, loadChromium, verificationErrors } from "./capture-support.mjs"

const wallet = path.resolve(import.meta.dirname, "../..")
const output = await mkdtemp(path.join(tmpdir(), "ult-785-production-worker-"))
const assets = path.join(wallet, "dist/assets")
const name = (await readdir(assets)).find((file) => /^qrDecoder\.worker-.*\.js$/.test(file))
assert(name, "Run pnpm build first: the actual App must emit its scanner worker")
const bytes = await readFile(path.join(assets, name))
const report = { evidence: "worker emitted by the production App vite.config.ts build, loaded from those exact bytes; controlled canvas input; production wallet authentication is not simulated", worker: name, sha256: createHash("sha256").update(bytes).digest("hex"), requests: [], cases: [] }
const server = createServer((request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp")
  response.setHeader("Permissions-Policy", "camera=(self), microphone=()")
  if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><title>Production app worker proof</title><video muted playsinline></video>'); return }
  response.writeHead(request.url === `/${name}` ? 200 : 404, { "Content-Type": "text/javascript" })
  response.end(request.url === `/${name}` ? bytes : "")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
let browser
try {
  const base = new URL(`http://127.0.0.1:${server.address().port}`)
  browser = await loadChromium(path.resolve(wallet, "../.."), process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  const context = await browser.newContext({ serviceWorkers: "block" })
  await installCaptureGuard(context, base, report)
  await installCameraFixture(context, { state: "live", payload: "@production-worker-check.zk.money" })
  context.on("request", (request) => report.requests.push(request.url()))
  const page = await context.newPage()
  await page.goto(base.href)
  const result = await page.evaluate(async (name) => {
    const media = await navigator.mediaDevices.getUserMedia({ video: true })
    const video = document.querySelector("video")
    video.srcObject = media
    await video.play()
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const drawing = canvas.getContext("2d"); drawing.drawImage(video, 0, 0)
    const frame = drawing.getImageData(0, 0, canvas.width, canvas.height)
    const worker = new Worker(`/${name}`, { type: "module" })
    try {
      const decoded = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Production worker timed out")), 10000)
        worker.onmessage = (event) => { clearTimeout(timeout); resolve(event.data) }
        worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)) }
        worker.postMessage({ data: frame.data, width: frame.width, height: frame.height }, [frame.data.buffer])
      })
      return { decoded, isolated: crossOriginIsolated, width: canvas.width, height: canvas.height }
    } finally { worker.terminate(); media.getTracks().forEach((track) => track.stop()); video.srcObject = null }
  }, name)
  assert.equal(result.decoded.text, "@production-worker-check.zk.money")
  assert.equal(result.isolated, true)
  assert.equal(await page.evaluate(() => window.__walletCaptureCamera.stats().activeTracks), 0)
  assert.deepEqual(verificationErrors(report), [])
  report.cases.push({ ...result, passed: true })
  await context.close()
} catch (error) { report.error = String(error); throw error }
finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve))
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2))
  console.info(`Production App worker evidence: ${output}`)
}
