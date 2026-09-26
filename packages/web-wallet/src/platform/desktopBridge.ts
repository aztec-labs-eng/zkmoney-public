/**
 * Client for the desktop launcher's L1 submit bridge. The launcher injects
 * `window.__ZKMONEY_DESKTOP_BRIDGE__` into its locally-served index.html; the
 * hosted deployment never has it, so every entry point below no-ops there.
 *
 * The bridge exists because the launched Chrome profile has no wallet
 * extensions: the app POSTs a prepared L1 transaction to its own local server,
 * the launcher opens a helper page in the user's DEFAULT browser (where their
 * MetaMask lives), and the app polls until the helper reports the tx hash.
 */
import type { Hex } from "viem"

export interface DesktopL1Bridge {
  l1SubmitPath: string
}

interface SubmissionStatus {
  state: "pending" | "submitted" | "superseded" | "error"
  txHash?: Hex
  message?: string
}

const POLL_INTERVAL_MS = 2_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export function getDesktopL1Bridge(): DesktopL1Bridge | null {
  const raw = (globalThis as { __ZKMONEY_DESKTOP_BRIDGE__?: unknown }).__ZKMONEY_DESKTOP_BRIDGE__
  if (!raw || typeof raw !== "object") return null
  const path = (raw as Record<string, unknown>).l1SubmitPath
  return typeof path === "string" && path.startsWith("/") ? { l1SubmitPath: path } : null
}

/** True when the desktop bridge is the only L1 signing route (no injected wallet). */
export function isDesktopL1SubmitActive(): boolean {
  return getDesktopL1Bridge() !== null && typeof window.ethereum === "undefined"
}

export interface DesktopL1SubmitParams {
  tx: { to: Hex; data: Hex; value?: Hex; chainId: number }
  /** Human-readable summary rendered on the helper page (labels and values). */
  display: { title: string; lines: [string, string][] }
  /** Called with the helper page's URL once it has been opened — shown to the
   *  user both as orientation and as the manual fallback if no page appeared. */
  onHelperOpened?: (submitUrl: string) => void
  timeoutMs?: number
}

/**
 * Hand the prepared transaction to the launcher (which opens the helper page)
 * and wait for the reported tx hash. A timeout here does NOT strand funds: an
 * approval that lands after we stop polling is still an ordinary transfer to
 * the deposit address, which SIPA discovery credits on a later sync.
 */
export async function submitViaDesktopBridge(params: DesktopL1SubmitParams): Promise<Hex> {
  const bridge = getDesktopL1Bridge()
  if (!bridge) throw new Error("Desktop L1 bridge is not available")

  const createResponse = await fetch(bridge.l1SubmitPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx: params.tx, display: params.display }),
  })
  if (!createResponse.ok) {
    throw new Error(`Desktop bridge refused the transaction: ${await createResponse.text()}`)
  }
  const { id, submitUrl } = (await createResponse.json()) as { id: string; submitUrl?: string }
  if (submitUrl) params.onHelperOpened?.(submitUrl)

  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const statusResponse = await fetch(`${bridge.l1SubmitPath}/${id}`)
    if (!statusResponse.ok) throw new Error("The transaction request expired — try again")
    const status = (await statusResponse.json()) as SubmissionStatus
    if (status.state === "submitted" && status.txHash) return status.txHash
    if (status.state === "superseded") {
      throw new Error("This transaction request was replaced by a newer one")
    }
    if (status.state === "error") {
      throw new Error(status.message ?? "The browser page reported an error")
    }
  }
  throw new Error(
    "Timed out waiting for the transaction from your browser. If you have already approved it, the deposit will still be detected automatically and will appear in your wallet.",
  )
}
