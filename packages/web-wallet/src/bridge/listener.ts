/**
 * The frame's one job: take a valid message from its parent on the campaign origin, store it as
 * hand-off material, and acknowledge. Anything else is ignored without a reply. The material's
 * `derivedAt` is stored as received, so a re-post cannot refresh it; the active pointers, the
 * identity and the breadcrumbs are never touched. A write that fails (storage refused or full)
 * is not acknowledged, so the campaign never believes material landed that did not.
 */
import { writeHandoffMaterial, type HandoffMaterial } from "../platform/storage/handoffMaterial"
import { ACK_TYPE, BRIDGE_VERSION, validateBridgeMessage } from "@obsidion/passkey-web"

export type BridgeEnv = {
  /** The one origin whose messages count; "" accepts nothing. */
  campaignOrigin: string
  rpId: string
}

export type BridgeSeams = {
  write?: (material: HandoffMaterial) => void | Promise<void>
  /** The frame's parent, for a page that is framed; tests stand a port in. */
  parentOf?: (win: Window) => MessageEventSource | null
}

export function installBridge(win: Window, env: BridgeEnv, seams: BridgeSeams = {}): () => void {
  const write = seams.write ?? writeHandoffMaterial
  const parentOf = seams.parentOf ?? ((w: Window) => (w.parent === w ? null : w.parent))
  const onMessage = async (event: MessageEvent) => {
    if (!env.campaignOrigin || event.origin !== env.campaignOrigin) return
    const parent = parentOf(win)
    if (!parent || event.source !== parent) return
    const verdict = validateBridgeMessage(event.data, { rpId: env.rpId })
    if (!verdict.ok) return
    const m = verdict.message
    try {
      await write({
        v: 1,
        derivedAt: m.derivedAt,
        rpId: m.rpId,
        credentialId: m.credentialId,
        pubkeyHex: `0x${m.pubkeyHex}`,
        candidates: m.candidates,
        ...(m.slot ? { slot: m.slot } : {}),
        ...(m.transports ? { transports: m.transports } : {}),
      })
    } catch {
      return
    }
    ;(event.source as Window).postMessage(
      { v: BRIDGE_VERSION, type: ACK_TYPE, nonce: m.nonce },
      { targetOrigin: event.origin },
    )
  }
  const listener = (event: MessageEvent) => void onMessage(event)
  win.addEventListener("message", listener)
  return () => win.removeEventListener("message", listener)
}
