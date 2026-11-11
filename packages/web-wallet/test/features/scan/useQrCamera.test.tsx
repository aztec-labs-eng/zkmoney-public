// Guard (privacy): the camera stops on pagehide, unmount and disable.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CameraState } from "../../../src/features/scan/cameraSession"
import { useQrCamera } from "../../../src/features/scan/useQrCamera"

const instances = vi.hoisted(
  () =>
    [] as Array<{
      stop: ReturnType<typeof vi.fn>
      start: ReturnType<typeof vi.fn>
      options: { onPayload: (text: string) => void; onState: (state: CameraState) => void }
    }>,
)
vi.mock("../../../src/features/scan/cameraSession", () => ({
  CameraSession: class {
    start = vi.fn(async () => {})
    stop = vi.fn()
    setTorch = vi.fn()
    constructor(
      public options: { onPayload: (text: string) => void; onState: (state: CameraState) => void },
    ) {
      instances.push(this)
    }
  },
}))

let root: Root
let host: HTMLDivElement
let camera: ReturnType<typeof useQrCamera>
const onPayload = vi.fn()
function Harness({
  enabled = true,
  attachVideo = true,
}: {
  enabled?: boolean
  attachVideo?: boolean
}) {
  camera = useQrCamera(enabled, onPayload)
  return attachVideo ? <video ref={camera.videoRef} muted playsInline /> : null
}
beforeEach(() => {
  instances.length = 0
  onPayload.mockReset()
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe("useQrCamera lifecycle", () => {
  it("stops on pagehide and removes listeners and stale callbacks on unmount", () => {
    act(() => root.render(<Harness />))
    const first = instances[0]
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(first.stop).toHaveBeenCalledOnce()
    act(() => root.render(null))
    const stopped = first.stop.mock.calls.length
    first.options.onPayload("@alice")
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(first.stop).toHaveBeenCalledTimes(stopped)
    expect(onPayload).not.toHaveBeenCalled()
  })
  it("releases capture when disabled by a route or breakpoint change", () => {
    act(() => root.render(<Harness />))
    act(() => root.render(<Harness enabled={false} />))
    expect(instances[0].stop).toHaveBeenCalledOnce()
    expect(instances).toHaveLength(1)
  })
})
