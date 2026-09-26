import { useCallback, useEffect, useRef, useState } from "react"
import { CameraSession, type CameraState } from "./cameraSession"

export function useQrCamera(enabled: boolean, onPayload: (text: string) => void) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const videoRef = useCallback((element: HTMLVideoElement | null) => setVideo(element), [])
  const session = useRef<CameraSession | undefined>(undefined)
  const callback = useRef(onPayload)
  callback.current = onPayload
  const [state, setState] = useState<CameraState>({ kind: "requesting" })
  const [attempt, setAttempt] = useState(0)
  const [deviceId, setDeviceId] = useState<string>()

  const stop = useCallback(() => session.current?.stop(), [])
  const restart = useCallback((selectedDeviceId?: string) => {
    session.current?.stop()
    setDeviceId(selectedDeviceId)
    setAttempt((value) => value + 1)
  }, [])
  const setTorch = useCallback((value: boolean) => session.current?.setTorch(value), [])

  useEffect(() => {
    if (!enabled) return
    if (!video) {
      setState((previous) =>
        previous.kind === "denied" || previous.kind === "unavailable" || previous.kind === "decode-error"
          ? previous
          : { kind: "unavailable", message: "Camera preview is unavailable. Paste a code below." },
      )
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        kind: "unavailable",
        message: "Camera access is unavailable in this browser. Paste a code below.",
      })
      return
    }
    let cancelled = false
    const camera = new CameraSession({
      video,
      mediaDevices: navigator.mediaDevices,
      deviceId,
      onState: (next) => {
        if (!cancelled) setState(next)
      },
      onPayload: (text) => {
        if (!cancelled) callback.current(text)
      },
    })
    session.current = camera
    const pause = () => {
      camera.stop()
      setState({ kind: "paused" })
    }
    const visibility = () => {
      if (document.visibilityState !== "visible") pause()
    }
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("pagehide", pause)
    if (document.visibilityState === "visible") void camera.start()
    else pause()
    return () => {
      cancelled = true
      camera.stop()
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("pagehide", pause)
      if (session.current === camera) session.current = undefined
    }
  }, [enabled, attempt, deviceId, video])

  return { videoRef, state, stop, restart, setTorch }
}
