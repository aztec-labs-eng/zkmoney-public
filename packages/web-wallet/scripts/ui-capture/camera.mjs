import { renderSVG } from "uqr"

const STATES = new Set(["denied", "pending", "unavailable", "live"])

export function cameraFixtureOptions(options) {
  if (!options || !STATES.has(options.state)) throw new Error("camera.state must be denied, pending, unavailable, or live")
  if (options.payload !== undefined && typeof options.payload !== "string") throw new Error("camera.payload must be a string")
  if (options.torch !== undefined && typeof options.torch !== "boolean") throw new Error("camera.torch must be a boolean")
  return { state: options.state, svg: options.payload ? renderSVG(options.payload) : null, torch: options.torch === true }
}

/** Installs controlled browser media without changing the wallet's camera or decoder modules. */
export async function installCameraFixture(context, options) {
  const config = cameraFixtureOptions(options)
  await context.addInitScript((initial) => {
    let mode = initial.state
    let svg = initial.svg
    let sequence = 0
    const streams = []
    const pending = []
    const canvases = []
    const stats = { requests: 0, stoppedTracks: 0, torchChanges: [] }
    let drawVersion = 0

    async function draw(canvas) {
      const context = canvas.getContext("2d")
      context.fillStyle = "#29252e"
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (!svg) return
      const version = drawVersion
      const picture = new Image()
      picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      await picture.decode()
      if (version !== drawVersion) return
      context.fillStyle = "white"
      context.fillRect(40, 40, 560, 560)
      context.drawImage(picture, 64, 64, 512, 512)
    }

    async function stream() {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 640
      canvases.push(canvas)
      await draw(canvas)
      const media = canvas.captureStream(5)
      streams.push(media)
      const id = `capture-camera-${++sequence}`
      const track = media.getVideoTracks()[0]
      let torchOn = false
      const stop = track.stop.bind(track)
      track.stop = () => { if (track.readyState !== "ended") stats.stoppedTracks++; torchOn = false; stop() }
      track.getCapabilities = () => initial.torch ? { torch: true } : {}
      track.getSettings = () => ({ deviceId: id, width: 640, height: 640, facingMode: "environment", ...(initial.torch ? { torch: torchOn } : {}) })
      if (initial.torch) {
        const applyConstraints = track.applyConstraints.bind(track)
        track.applyConstraints = async (constraints) => {
          const torch = constraints?.advanced?.find((value) => typeof value.torch === "boolean")?.torch
          if (torch === undefined) return applyConstraints(constraints)
          if (track.readyState === "ended") throw new DOMException("Controlled camera ended", "InvalidStateError")
          torchOn = torch
          stats.torchChanges.push(torch)
        }
      }
      return media
    }
    const denied = () => new DOMException("Controlled permission denial", "NotAllowedError")
    const getUserMedia = async () => {
      stats.requests++
      if (mode === "denied") throw denied()
      if (mode === "unavailable") throw new DOMException("Controlled busy camera", "NotReadableError")
      if (mode === "pending") return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      return stream()
    }
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: async () => [] },
    })
    window.__walletCaptureCamera = {
      async grant() {
        mode = "live"
        for (const request of pending.splice(0)) request.resolve(await stream())
      },
      deny() {
        mode = "denied"
        for (const request of pending.splice(0)) request.reject(denied())
      },
      async payload(nextSvg) {
        svg = nextSvg
        drawVersion++
        await Promise.all(canvases.map(draw))
        for (const media of streams) for (const track of media.getVideoTracks()) track.requestFrame?.()
      },
      end() {
        for (const media of streams) for (const track of media.getTracks()) {
          track.stop()
          track.dispatchEvent(new Event("ended"))
        }
      },
      stats() {
        const active = streams.flatMap((media) => media.getTracks()).filter((track) => track.readyState === "live")
        return { ...stats, pending: pending.length, activeTracks: active.length, activeTorchTracks: active.filter((track) => track.getSettings().torch).length }
      },
    }
  }, config)
}

export async function cameraStep(page, step) {
  if (!["grant", "deny", "payload", "end", "assertStopped"].includes(step.operation)) throw new Error(`Unknown camera operation: ${step.operation}`)
  if (step.operation === "payload" && typeof step.value !== "string") throw new Error("camera payload operation requires a string value")
  const svg = step.operation === "payload" && step.value ? renderSVG(step.value) : null
  return page.evaluate(async ({ operation, svg }) => {
    const camera = window.__walletCaptureCamera
    if (!camera) throw new Error("This plan needs a camera fixture")
    if (operation === "assertStopped") {
      const stats = camera.stats()
      if (stats.activeTracks !== 0) throw new Error(`Camera still has ${stats.activeTracks} active tracks`)
      return stats
    }
    if (operation === "payload") await camera.payload(svg)
    else await camera[operation]()
    return camera.stats()
  }, { operation: step.operation, svg })
}
