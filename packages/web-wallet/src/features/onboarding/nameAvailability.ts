/**
 * Live availability of a tag as it is typed, from account-service's open `GET /domain/available`:
 * the global blocklist plus reservations held by other in-flight claims. Neither is visible to the
 * Registry read behind `getClaimStatus`, which only sees names already on chain.
 *
 * Advisory. Every failure resolves to "unknown" and leaves the pick open, because `/domain/sign`
 * decides the claim and re-checks both gates itself.
 */
import { useEffect, useState } from "react"
import { AccountServiceClient, composeWireNameHash, normalizeTag } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { getOxideTuple, requireTupleField } from "../../config/oxideTuple"

export type NameAvailability = "available" | "reserved" | "blocked" | "blocked-reserved" | "unknown"

/** The anonymous probe cannot identify a reservation holder or validate a route grant. */
export function nameIsUnavailable(
  status: NameAvailability,
  { resuming, allowBlocked = false }: { resuming: boolean; allowBlocked?: boolean },
): boolean {
  const blocked = status === "blocked" || status === "blocked-reserved"
  const reserved = status === "reserved" || status === "blocked-reserved"
  return (blocked && !allowBlocked) || (reserved && !resuming)
}

const DEBOUNCE_MS = 350
// Short: the client retries a rejected read twice more, and a type-ahead spinner must not outlast
// the user's patience on a dead network.
const TIMEOUT_MS = 2000

function isStatus(value: unknown): value is "available" | "reserved" | "blocked" {
  return value === "available" || value === "reserved" || value === "blocked"
}

/** Credential-free: the probe is an open route, and typing a name must not need keys. */
const accountServiceReader = (config: ReturnType<typeof getConfig>) =>
  new AccountServiceClient(config.accountServiceUrl, { readOnly: true, timeoutMs: TIMEOUT_MS })

/**
 * One probe of a bare tag. Never throws: a refusal, a timeout and an offline browser all read as
 * "unknown". The tag is folded before it is hashed so the probe asks about the node the tag would
 * actually register under.
 */
export async function probeNameAvailability(handle: string): Promise<NameAvailability> {
  try {
    const bare = normalizeTag(handle)
    if (bare === null) return "unknown"
    const config = getConfig()
    const tuple = await getOxideTuple(config)
    const nameHash = composeWireNameHash(bare, requireTupleField(tuple, "ensDomain"))
    const { status, blocked } = await accountServiceReader(config).availableNameDetails(nameHash)
    if (!isStatus(status)) return "unknown"
    if (status === "reserved" && blocked) return "blocked-reserved"
    return blocked ? "blocked" : status
  } catch {
    return "unknown"
  }
}

/** A tag's answer, plus whether one is still being worked out. */
export type NameCheck = { status: NameAvailability; checking: boolean }
type StoredNameCheck = NameCheck & { handle: string | null }

/**
 * Debounced probe of the tag being typed. `checking` covers the debounce and the request together,
 * so the caller shows one uninterrupted spinner rather than blinking between the two; `status`
 * stays "unknown" until an answer lands. The cleanup drops both the pending debounce and a reply
 * that arrives after the tag moved on.
 */
export function useNameAvailability(handle: string, enabled: boolean): NameCheck {
  const [check, setCheck] = useState<StoredNameCheck>({
    handle: null,
    status: "unknown",
    checking: false,
  })
  useEffect(() => {
    if (!enabled || normalizeTag(handle) === null) {
      setCheck({ handle: null, status: "unknown", checking: false })
      return
    }
    setCheck({ handle, status: "unknown", checking: true })
    let live = true
    const timer = setTimeout(() => {
      void probeNameAvailability(handle).then((status) => {
        if (live) setCheck({ handle, status, checking: false })
      })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [handle, enabled])
  if (!enabled || normalizeTag(handle) === null) return { status: "unknown", checking: false }
  // A seeded tag and a just-edited tag must wait even before the effect schedules their probe.
  if (check.handle !== handle) return { status: "unknown", checking: true }
  return { status: check.status, checking: check.checking }
}
