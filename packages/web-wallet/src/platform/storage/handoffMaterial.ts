/**
 * Key material the campaign bridge leaves for a hand-off to take: the passkey it derived from,
 * every PRF candidate it evaluated, as 0x-prefixed hex, the slot its own account is derived from,
 * and the transports the passkey's creation reported when the campaign had them. `derivedAt` is the campaign's own stamp, stored as
 * received, so a re-post cannot refresh it. Global key by design; it never touches the active
 * pointers, and only a hand-off naming its credential takes it, once. No-ops without
 * `localStorage`.
 */
import type { PrfSlot } from "@obsidion/core/types"
import { isTransportList } from "@obsidion/passkey-web"
import { withWebLock } from "./webLock"

const HANDOFF_KEY = "webwallet.handoff"

const store = () => (typeof localStorage === "undefined" ? undefined : localStorage)

export type HandoffMaterial = {
  v: 1
  derivedAt: number
  rpId: string
  credentialId: string
  pubkeyHex: string
  candidates: { first?: string; second?: string }
  slot?: PrfSlot
  transports?: readonly string[]
}

/** Material older than this at the attempt is refused unread. */
export const HANDOFF_MAX_AGE_MS = 10 * 60_000
/** A stamp further in the future than this is refused: a wrong clock, not a fresh ceremony. */
export const HANDOFF_FUTURE_SKEW_MS = 60_000

const isHex = (value: unknown, bytes: number): value is string =>
  typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)

/** The material as stored, or null when absent; a blob of another shape is removed. */
export function readHandoffMaterial(): HandoffMaterial | null {
  const raw = store()?.getItem(HANDOFF_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<HandoffMaterial>
    const candidates = parsed.candidates ?? {}
    const first = isHex(candidates.first, 32) ? candidates.first : undefined
    const second = isHex(candidates.second, 32) ? candidates.second : undefined
    const transports = parsed.transports
    const slot = parsed.slot
    if (
      parsed.v === 1 &&
      typeof parsed.derivedAt === "number" &&
      typeof parsed.rpId === "string" &&
      typeof parsed.credentialId === "string" &&
      isHex(parsed.pubkeyHex, 64) &&
      (first || second) &&
      (slot === undefined || (slot === "first" ? first : slot === "second" ? second : false)) &&
      (transports === undefined || isTransportList(transports))
    ) {
      return {
        v: 1,
        derivedAt: parsed.derivedAt,
        rpId: parsed.rpId,
        credentialId: parsed.credentialId,
        pubkeyHex: parsed.pubkeyHex,
        candidates: { ...(first ? { first } : {}), ...(second ? { second } : {}) },
        ...(slot ? { slot } : {}),
        ...(transports ? { transports } : {}),
      }
    }
  } catch {
    // Not JSON: handled below like any other unusable blob.
  }
  store()?.removeItem(HANDOFF_KEY)
  return null
}

/** The bridge's write, serialized with every take and sweep so neither can drop it unread. */
export function writeHandoffMaterial(material: HandoffMaterial): Promise<void> {
  return withWebLock(HANDOFF_KEY, async () => {
    store()?.setItem(HANDOFF_KEY, JSON.stringify(material))
  })
}

export function clearHandoffMaterial(): void {
  store()?.removeItem(HANDOFF_KEY)
}

/**
 * Take the material for `credentialId` under `rpId`, removing it so no second tab can. Material
 * for another credential stays for the hand-off it belongs to; material for another RP, or with
 * a stamp that is not a safe integer, older than ten minutes, or more than a minute ahead, is
 * removed unread.
 */
export function takeHandoffMaterial(
  credentialId: string,
  rpId: string,
  now: number = Date.now(),
): Promise<HandoffMaterial | null> {
  return withWebLock(HANDOFF_KEY, async () => {
    const material = readHandoffMaterial()
    if (!material) return null
    if (material.rpId !== rpId) {
      clearHandoffMaterial()
      return null
    }
    if (material.credentialId !== credentialId) return null
    if (!stampIsLive(material.derivedAt, now)) {
      clearHandoffMaterial()
      return null
    }
    clearHandoffMaterial()
    return material
  })
}

/** Whether a stamp is one `takeHandoffMaterial` would still accept at `now`. */
function stampIsLive(derivedAt: number, now: number): boolean {
  const age = now - derivedAt
  return (
    Number.isSafeInteger(derivedAt) && age <= HANDOFF_MAX_AGE_MS && age >= -HANDOFF_FUTURE_SKEW_MS
  )
}

/**
 * Remove material no hand-off can take any more, so a post nobody followed does not sit in
 * storage. Run once at boot; live material is left for the hand-off it belongs to.
 */
export function sweepExpiredHandoffMaterial(
  now: number = Date.now(),
  rpId?: string,
): Promise<void> {
  return withWebLock(HANDOFF_KEY, async () => {
    const material = readHandoffMaterial()
    if (
      material &&
      (!stampIsLive(material.derivedAt, now) || (rpId !== undefined && material.rpId !== rpId))
    ) {
      clearHandoffMaterial()
    }
  })
}

/**
 * Take the material, waiting up to `waitMs` for the bridge's write if it is not there yet. The
 * storage listener is armed before the first read, so a write landing between the two is seen. A
 * take that fails (a refused lock, a blocked store) counts as no material. Listener and timer are
 * released on every exit.
 */
export function awaitHandoffMaterial(
  credentialId: string,
  rpId: string,
  waitMs: number,
): Promise<HandoffMaterial | null> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === HANDOFF_KEY) attempt()
    }
    const finish = (material: HandoffMaterial | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
      resolve(material)
    }
    const none = () => finish(null)
    const attempt = () =>
      void takeHandoffMaterial(credentialId, rpId).then((material) => {
        if (material) finish(material)
      }, none)
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
    void takeHandoffMaterial(credentialId, rpId).then((material) => {
      if (material || settled) return finish(material)
      if (waitMs <= 0) return finish(null)
      timer = setTimeout(none, waitMs)
    }, none)
  })
}
