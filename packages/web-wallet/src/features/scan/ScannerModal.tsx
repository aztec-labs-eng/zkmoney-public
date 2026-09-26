import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { PhoneIcon } from "../../ui/PhoneIcon"
import { Modal } from "../../ui/Modal"
import { createScanHandoff } from "./scanHandoff"
import type { ScanDestination, ScanResult } from "./scanPayload"
import { useQrCamera } from "./useQrCamera"
import "./scanner.css"

export interface ScannerModalProps {
  onClose: () => void
  onShare?: () => void
  resolvePayload: (text: string) => Promise<ScanResult>
  onDestination: (destination: ScanDestination) => void
}

/** The parent owns phone/identity guards, navigation, origin and focus restoration. */
export function ScannerModal(props: ScannerModalProps) {
  const callbacks = useRef(props)
  callbacks.current = props
  const handoff = useRef<ReturnType<typeof createScanHandoff> | null>(null)
  const leaving = useRef(false)
  const exitRequested = useRef(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  const submittedSource = useRef<"camera" | "manual">("camera")
  const acceptedSource = useRef<"camera" | "manual">("camera")
  const mounted = useRef(false)
  const [departing, setDeparting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; source: "camera" | "manual" } | null>(null)
  const [text, setText] = useState("")
  const [torchBusy, setTorchBusy] = useState(false)
  const fieldId = useId()
  const messageId = useId()
  const camera = useQrCamera(!departing, (payload) => {
    submittedSource.current = "camera"
    void handoff.current?.submit(payload)
  })

  useLayoutEffect(() => {
    // A removed retry, torch or camera selector must not leave keyboard focus behind the dialog.
    if (!leaving.current && document.activeElement === document.body) closeButton.current?.focus({ preventScroll: true })
  }, [camera.state, error, busy, departing])

  useEffect(() => {
    mounted.current = true
    const transfer = createScanHandoff({
      resolve: (payload) => {
        acceptedSource.current = submittedSource.current
        return callbacks.current.resolvePayload(payload)
      },
      stopCamera: camera.stop,
      onBusy: (value) => {
        if (value) setError(null)
        setBusy(value)
      },
      onError: (message) => setError({ message, source: acceptedSource.current }),
      onDestination: (destination) => {
        leaving.current = true
        setDeparting(true)
        callbacks.current.onDestination(destination)
      },
    })
    handoff.current = transfer
    return () => {
      mounted.current = false
      transfer.dispose()
      if (handoff.current === transfer) handoff.current = null
    }
  }, [camera.stop])

  const leave = (action: () => void, allowAfterDestination = false) => {
    if (exitRequested.current || (leaving.current && !allowAfterDestination)) return
    exitRequested.current = true
    leaving.current = true
    handoff.current?.dispose()
    camera.stop()
    setDeparting(true)
    action()
  }
  const close = () => leave(() => callbacks.current.onClose(), true)
  const retry = (deviceId?: string) => {
    if (busy || leaving.current) return
    setError(null)
    camera.restart(deviceId)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!leaving.current) {
      submittedSource.current = "manual"
      void handoff.current?.submit(text)
    }
  }
  const toggleTorch = async () => {
    if (torchBusy || camera.state.kind !== "active") return
    setTorchBusy(true)
    try {
      await camera.setTorch(!camera.state.torchOn)
    } finally {
      if (mounted.current) setTorchBusy(false)
    }
  }

  const paused = camera.state.kind === "paused"
  const controls = camera.state.kind === "active" && !error && !busy && !departing ? camera.state : null
  const recovery = error?.message ?? ("message" in camera.state ? camera.state.message : null)
  const message = recovery ?? (departing ? "Opening your code…" : busy ? "Checking your code…" : paused
    ? "Camera paused while you were away."
    : camera.state.kind === "requesting" ? "Allow camera access to scan, or paste a code below."
      : "Point your camera at a wallet QR code.")

  return (
    <Modal variant="bare" className="ww-scan" label="Scan QR code" onClose={close}>
      <div className="ww-scan__toolbar">
        <button ref={closeButton} type="button" className="ww-scan__icon-button" aria-label="Close scanner" onClick={close}>
          <PhoneIcon name="x" size={24} color="rgba(255, 255, 255, 0.6)" />
        </button>
        {controls?.torch && (
          <button type="button" className="ww-scan__icon-button" aria-label={controls.torchOn ? "Turn flashlight off" : "Turn flashlight on"}
            aria-pressed={controls.torchOn} disabled={torchBusy} onClick={() => void toggleTorch()}>
            <PhoneIcon name="flashlight" size={24} />
          </button>
        )}
      </div>

      <div className="ww-scan__preview">
        {/* Keep the video attached beneath every state panel so retry always has a capture target. */}
        <video ref={camera.videoRef} className="ww-scan__video" autoPlay muted playsInline aria-hidden="true" />
        <div className="ww-scan__frame" aria-hidden="true">
          <i /><i /><i /><i />
        </div>
        {(recovery || paused || busy || departing || camera.state.kind === "requesting") && (
          <div className="ww-scan__state">
            <p id={messageId} role={recovery ? "alert" : "status"}>{message}</p>
            {(recovery || paused) && !busy && !departing && (
              <button type="button" className="ww-scan__retry" onClick={() => retry()}>
                {paused ? "Resume camera" : "Try camera again"}
              </button>
            )}
          </div>
        )}
      </div>
      {controls && <p className="ww-scan__hint" role="status">{message}</p>}
      {!!controls?.alternatives.length && (
        <label className="ww-scan__camera">
          Camera
          <select aria-label="Camera" value={controls.deviceId ?? ""} onChange={(event) => retry(event.target.value)}>
            <option value={controls.deviceId ?? ""}>Current camera</option>
            {controls.alternatives.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
        </label>
      )}

      <div className="ww-scan__actions">
        {props.onShare && (
          <div className="ww-scan__share">
            <span>Share @tag?</span>
            <button type="button" className="ww-scan__share-button" disabled={departing} onClick={() => leave(() => callbacks.current.onShare?.())}>
              Show my QR code <PhoneIcon name="qr-code" size={24} />
            </button>
          </div>
        )}
        <form className="ww-scan__paste" onSubmit={submit}>
          <label htmlFor={fieldId}>Paste a link or @tag</label>
          <div className="ww-scan__paste-row">
            <input id={fieldId} type="text" value={text} onChange={(event) => setText(event.target.value)}
              autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Link or @tag"
              aria-invalid={error?.source === "manual"} aria-describedby={error?.source === "manual" ? messageId : undefined} disabled={busy || departing} />
            <button type="submit" className="ww-scan__continue" disabled={!text.trim() || busy || departing}>Continue</button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
