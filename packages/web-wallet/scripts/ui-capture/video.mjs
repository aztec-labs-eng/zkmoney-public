import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { writeOutputFile } from "./output.mjs"

const exec = promisify(execFile)
const FRAME_INTERVAL_MS = 200

export async function requireVideoTools() {
  await Promise.all([exec("ffmpeg", ["-version"]), exec("ffprobe", ["-version"])])
}

export async function videoDimensions(file) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "json", file,
  ])
  const [{ width, height }] = JSON.parse(stdout).streams
  return { width, height }
}

export async function startVideo(page, viewport) {
  const session = await page.context().newCDPSession(page)
  const directory = await mkdtemp(path.join(tmpdir(), "web-wallet-frames-")).catch(async (error) => {
    await session.detach().catch(() => {})
    throw error
  })
  const started = performance.now()
  const frames = []
  let stopping = false
  let wake
  let timer
  let failure
  let finishPromise
  let captureRetries = 0
  const cleanup = async () => {
    await session.detach().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
  const capture = async () => {
    let png
    let at
    for (let attempt = 0; ; attempt++) {
      at = (performance.now() - started) / 1000
      try {
        // PNG screenshots retain odd viewport edges; Chromium's screencast can omit the final row.
        const { data } = await session.send("Page.captureScreenshot", {
          format: "png", fromSurface: true, captureBeyondViewport: false,
        })
        png = Buffer.from(data, "base64")
        break
      } catch (error) {
        // Navigation can briefly leave Chromium without an active renderer for this page.
        if (page.isClosed() || attempt >= 9 || !String(error).includes("Protocol error (Page.captureScreenshot): Not attached to an active page")) throw error
        captureRetries++
        await delay(100)
      }
    }
    if (png.readUInt32BE(16) !== viewport.width || png.readUInt32BE(20) !== viewport.height) {
      throw new Error("Recording frame dimensions differ from the CSS viewport")
    }
    const file = `frame-${frames.length}.png`
    await writeFile(path.join(directory, file), png, { flag: "wx" })
    frames.push({ file, at })
  }
  try { await capture() }
  catch (error) { await cleanup(); throw error }
  const loop = (async () => {
    while (!stopping) {
      const previous = frames.at(-1).at * 1000 + started
      await new Promise((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, Math.max(0, FRAME_INTERVAL_MS - (performance.now() - previous)))
      })
      if (!stopping) await capture()
    }
  })().catch((error) => { failure = error })

  const finish = async (outputRoot) => {
    stopping = true
    clearTimeout(timer)
    wake?.()
    await loop
    try {
      if (failure) throw failure
      await capture()
      const durationSeconds = (performance.now() - started) / 1000
      const entries = frames.map((frame, index) => {
        const end = frames[index + 1]?.at ?? durationSeconds
        return `file '${frame.file}'\nduration ${Math.max(0.001, end - frame.at).toFixed(6)}`
      })
      entries.push(`file '${frames.at(-1).file}'`)
      await writeFile(path.join(directory, "frames.txt"), `${entries.join("\n")}\n`)
      const encoded = path.join(directory, "recording.webm")
      await exec("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "1", "-i", path.join(directory, "frames.txt"),
        "-fps_mode", "vfr", "-pix_fmt", "yuv444p", "-c:v", "libvpx-vp9", "-lossless", "1",
        "-deadline", "realtime", "-cpu-used", "8", "-an", encoded,
      ])
      const size = await videoDimensions(encoded)
      if (size.width !== viewport.width || size.height !== viewport.height) throw new Error("Recording dimensions differ from the CSS viewport")
      const file = await writeOutputFile(outputRoot, "recording.webm", await readFile(encoded))
      return { file, size, method: "viewport-png", frameIntervalMs: FRAME_INTERVAL_MS, frames: frames.length, durationSeconds, captureRetries }
    } finally { await cleanup() }
  }
  return { startedAt: started, finish: (outputRoot) => finishPromise ??= finish(outputRoot) }
}
