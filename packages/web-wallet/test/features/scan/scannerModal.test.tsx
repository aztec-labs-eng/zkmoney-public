// Guards: one handoff for racing inputs; no handoff after the scanner closes or unmounts.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CameraState } from "../../../src/features/scan/cameraSession"
import type { ScanResult } from "../../../src/features/scan/scanPayload"
import { ScannerModal, type ScannerModalProps } from "../../../src/features/scan/ScannerModal"

const fixture = vi.hoisted(() => ({
  state: { kind: "requesting" } as CameraState,
  onPayload: (_text: string) => {},
  stop: vi.fn(),
  restart: vi.fn(),
  setTorch: vi.fn(async () => true),
  videoRef: vi.fn(),
}))
vi.mock("../../../src/features/scan/useQrCamera", () => ({
  useQrCamera: (_enabled: boolean, onPayload: (text: string) => void) => {
    fixture.onPayload = onPayload
    return fixture
  },
}))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => <span />,
  GradientText: () => <span />,
  TopNavIconButton: () => <span />,
}))

let root: Root
let host: HTMLDivElement
let props: ScannerModalProps
function render() {
  act(() => root.render(<ScannerModal {...props} />))
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text || node.getAttribute("aria-label") === text,
  )!
}
function fill(value: string) {
  const input = host.querySelector("input")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function submit() {
  act(() =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  )
}
const valid: ScanResult = {
  kind: "destination",
  destination: { to: "/contacts", state: { searchTag: "alice" } },
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.state = { kind: "requesting" }
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  props = {
    onClose: vi.fn(),
    onShare: vi.fn(),
    resolvePayload: vi.fn(async () => valid),
    onDestination: vi.fn(),
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("isolated ScannerModal", () => {
  it("uses one resolver and one handoff for simultaneous camera and manual input", async () => {
    let resolve!: (result: ScanResult) => void
    props.resolvePayload = vi.fn(
      () =>
        new Promise<ScanResult>((done) => {
          resolve = done
        }),
    )
    render()
    fill("@bob")
    act(() => fixture.onPayload("@alice"))
    submit()
    expect(props.resolvePayload).toHaveBeenCalledOnce()
    expect(props.resolvePayload).toHaveBeenCalledWith("@alice")
    expect(button("Continue").disabled).toBe(true)
    await act(async () => resolve(valid))
    act(() => fixture.onPayload("@bob"))
    expect(props.onDestination).toHaveBeenCalledOnce()
  })
  it.each(["Close scanner", "Show my QR code"])(
    "stops capture before %s and ignores pending classification",
    async (action) => {
      let resolve!: (result: ScanResult) => void
      props.resolvePayload = vi.fn(
        () =>
          new Promise<ScanResult>((done) => {
            resolve = done
          }),
      )
      let stopsAtExit = 0
      const leaving = vi.fn(() => {
        stopsAtExit = fixture.stop.mock.calls.length
      })
      if (action === "Close scanner") props.onClose = leaving
      else props.onShare = leaving
      render()
      act(() => fixture.onPayload("@alice"))
      const before = fixture.stop.mock.calls.length
      act(() => button(action).click())
      expect(stopsAtExit).toBeGreaterThan(before)
      await act(async () => resolve(valid))
      expect(props.onDestination).not.toHaveBeenCalled()
      expect(leaving).toHaveBeenCalledOnce()
    },
  )
  it("ignores an asynchronous handoff after the surface unmounts", async () => {
    let resolve!: (result: ScanResult) => void
    props.resolvePayload = vi.fn(
      () =>
        new Promise<ScanResult>((done) => {
          resolve = done
        }),
    )
    render()
    act(() => fixture.onPayload("@alice"))
    act(() => root.render(null))
    await act(async () => resolve(valid))
    expect(props.onDestination).not.toHaveBeenCalled()
    expect(fixture.stop).toHaveBeenCalled()
  })
})
