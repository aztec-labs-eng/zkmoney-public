import { createQrDecoder, type QrDecoder } from "./qrDecoder"
import { MAX_QR_FRAME_SIDE } from "./qrFrame"

export type CameraState =
  | { kind: "requesting" }
  | {
      kind: "active"
      torch: boolean
      torchOn: boolean
      alternatives: MediaDeviceInfo[]
      deviceId?: string
    }
  | { kind: "paused" }
  | { kind: "denied" | "unavailable" | "decode-error"; message: string }

interface CameraOptions {
  video: HTMLVideoElement
  mediaDevices: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">
  onState: (state: CameraState) => void
  onPayload: (text: string) => void
  deviceId?: string
  createDecoder?: () => QrDecoder
  readFrame?: (video: HTMLVideoElement) => ImageData | null
}

function frameReader() {
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d", { willReadFrequently: true })
  return (video: HTMLVideoElement): ImageData | null => {
    if (!context) throw new Error("Camera frames are unavailable")
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
    const scale = Math.min(1, MAX_QR_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return context.getImageData(0, 0, canvas.width, canvas.height)
  }
}

/** One capture lifetime. A stopped instance never adopts a late stream or emits another result. */
export class CameraSession {
  private stopped = false
  private started = false
  private stream?: MediaStream
  private decoder?: QrDecoder
  private timer?: ReturnType<typeof setTimeout>
  private active?: Extract<CameraState, { kind: "active" }>
  private changingTorch = false

  constructor(private readonly options: CameraOptions) {}

  async start(): Promise<void> {
    if (this.started || this.stopped) return
    this.started = true
    const { video, mediaDevices, deviceId, onState } = this.options
    onState({ kind: "requesting" })
    let cameraGranted = false
    try {
      video.muted = true
      video.playsInline = true
      video.setAttribute("playsinline", "")
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId
            ? { deviceId: { exact: deviceId } }
            : { facingMode: { ideal: "environment" } }),
          width: { ideal: MAX_QR_FRAME_SIDE },
          height: { ideal: MAX_QR_FRAME_SIDE },
        },
      })
      cameraGranted = true
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.stream = stream
      const track = stream.getVideoTracks()[0]
      if (!track || track.readyState === "ended") throw new Error("No usable camera")
      track.addEventListener("ended", this.onEnded)
      video.srcObject = stream
      await video.play()
      if (this.stopped) return
      const capabilities = track.getCapabilities?.() as
        | (MediaTrackCapabilities & { torch?: boolean })
        | undefined
      const selected = track.getSettings?.().deviceId
      this.active = {
        kind: "active",
        torch: capabilities?.torch === true,
        torchOn: false,
        alternatives: [],
        deviceId: selected,
      }
      onState(this.active)
      // Device enumeration must not delay capture, and labels are useful only after permission.
      void mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (this.stopped || !this.active) return
          const alternatives = devices.filter(
            (device, index) =>
              device.kind === "videoinput" &&
              !!device.deviceId &&
              !!device.label &&
              !!selected &&
              device.deviceId !== selected &&
              devices.findIndex((other) => other.deviceId === device.deviceId) === index,
          )
          this.active = { ...this.active, alternatives }
          onState(this.active)
        })
        .catch(() => {})
      try {
        this.decoder = (this.options.createDecoder ?? createQrDecoder)()
        void this.scan(this.options.readFrame ?? frameReader())
      } catch {
        this.decodeFailed()
      }
    } catch (error) {
      if (this.stopped) return
      this.stop()
      const denied =
        !cameraGranted &&
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        ["NotAllowedError", "SecurityError"].includes(String(error.name))
      onState(
        denied
          ? {
              kind: "denied",
              message:
                "Camera access was denied. Allow camera access in your browser settings, or paste a code below.",
            }
          : {
              kind: "unavailable",
              message:
                "The camera is unavailable. Close other apps using it and try again, or paste a code below.",
            },
      )
    }
  }

  private readonly onEnded = () => {
    if (this.stopped) return
    this.stop()
    this.options.onState({
      kind: "unavailable",
      message: "The camera stopped. Try again, or paste a code below.",
    })
  }

  private decodeFailed() {
    if (this.stopped) return
    this.stop()
    this.options.onState({
      kind: "decode-error",
      message: "Couldn't read the camera. Try again, or paste a code below.",
    })
  }

  private async scan(readFrame: (video: HTMLVideoElement) => ImageData | null): Promise<void> {
    if (this.stopped) return
    try {
      const frame = readFrame(this.options.video)
      const text = frame ? await this.decoder!.decode(frame) : null
      if (this.stopped) return
      if (text) {
        this.stop()
        this.options.onPayload(text)
        return
      }
    } catch {
      this.decodeFailed()
      return
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.scan(readFrame), 200)
  }

  async setTorch(enabled: boolean): Promise<boolean> {
    if (this.stopped || !this.active?.torch || this.changingTorch) return false
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return false
    this.changingTorch = true
    try {
      await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] })
      if (this.stopped) return false
      this.active = { ...this.active, torchOn: enabled }
      this.options.onState(this.active)
      return true
    } catch {
      if (!this.stopped) {
        if (enabled && this.active && !this.active.torchOn) {
          this.active = { ...this.active, torch: false, torchOn: false }
          this.options.onState(this.active)
        } else {
          this.stop()
          this.options.onState({
            kind: "unavailable",
            message: "Camera controls are unavailable. Try again, or paste a code below.",
          })
        }
      }
      return false
    } finally {
      this.changingTorch = false
    }
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.decoder?.destroy()
    this.stream?.getTracks().forEach((track) => {
      track.removeEventListener("ended", this.onEnded)
      track.stop()
    })
    if (this.stream && this.options.video.srcObject === this.stream) {
      this.options.video.pause()
      this.options.video.srcObject = null
    }
    this.stream = undefined
  }
}
