import { useCallback, useEffect, useRef, useState } from "react"
import type { ScanDestination, ScanResult } from "./scanPayload"

type Surface = "scan" | "share"
interface Session {
  id: number
  surface: Surface
  origin: Surface
  opener: HTMLElement | null
  routeKey: string
  identityKey?: string
}
interface Options {
  routeKey: string
  identityKey?: string
  scanAvailable: boolean
  fallback: () => HTMLElement | null
  resolve: (payload: string) => Promise<ScanResult>
  onDestination: (destination: ScanDestination) => void
}

/** One origin per opening; switching surfaces replaces the view without adding route history. */
export function useScanShare(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const sequence = useRef(0)
  const current = useRef<Session | null>(null)
  const focusAfterClose = useRef<{ opener: HTMLElement | null; routeKey: string } | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const valid = (value: Session) => value.routeKey === options.routeKey && value.identityKey === options.identityKey &&
    ((value.surface !== "scan" && value.origin !== "scan") || options.scanAvailable)
  const visible = session && valid(session) ? session : null
  const publish = useCallback((value: Session | null) => {
    current.current = value
    setSession(value)
  }, [])

  useEffect(() => {
    if (session && !visible) {
      focusAfterClose.current = { opener: session.opener, routeKey: session.routeKey }
      publish(null)
    }
  }, [session, visible, publish])
  useEffect(() => {
    if (visible || !focusAfterClose.current) return
    const request = focusAfterClose.current
    focusAfterClose.current = null
    if (request.routeKey !== latest.current.routeKey || document.querySelector("dialog[open]")) return
    const opener = request.opener
    const target = opener?.isConnected && opener.getClientRects().length ? opener : latest.current.fallback()
    target?.focus({ preventScroll: true })
  }, [visible])

  useEffect(() => () => {
    current.current = null
    focusAfterClose.current = null
  }, [])

  const open = useCallback((surface: Surface, opener: HTMLElement | null) => {
    if (surface === "scan" && !latest.current.scanAvailable) return
    focusAfterClose.current = null
    publish({ id: ++sequence.current, surface, origin: surface, opener,
      routeKey: latest.current.routeKey, identityKey: latest.current.identityKey })
  }, [publish])
  const active = (id: number) => {
    const value = current.current
    const config = latest.current
    return value?.id === id && value.routeKey === config.routeKey && value.identityKey === config.identityKey &&
      ((value.surface !== "scan" && value.origin !== "scan") || config.scanAvailable) ? value : null
  }
  const switchTo = (id: number, surface: Surface) => {
    const value = active(id)
    if (!value || (surface === "scan" && !latest.current.scanAvailable)) return
    publish({ ...value, id: ++sequence.current, surface })
  }
  const close = (id: number) => {
    const value = active(id)
    if (!value) return
    if (value.surface !== value.origin) {
      switchTo(id, value.origin)
      return
    }
    focusAfterClose.current = { opener: value.opener, routeKey: value.routeKey }
    publish(null)
  }
  const resolve = async (id: number, payload: string): Promise<ScanResult> => {
    if (!active(id) || !latest.current.scanAvailable) return { kind: "error", message: "Unlock your registered wallet to scan a code." }
    const result = await latest.current.resolve(payload)
    return active(id) && latest.current.scanAvailable ? result : { kind: "error", message: "This scanner session has closed." }
  }
  const destination = (id: number, value: ScanDestination) => {
    if (!active(id) || !latest.current.scanAvailable) return
    // Invalidate old close callbacks before navigation; a late Close never returns to the origin.
    focusAfterClose.current = null
    publish(null)
    latest.current.onDestination(value)
  }

  return { session: visible, open, switchTo, close, resolve, destination }
}
