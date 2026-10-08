/** Live name policy and grant status while a tag is typed. `/domain/sign` remains authoritative. */
import { useEffect, useState } from "react"
import { AccountServiceClient, composeWireNameHash, normalizeTag } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { getOxideTuple, requireTupleField } from "../../config/oxideTuple"

export type NameAvailability = "available" | "reserved" | "blocked" | "blocked-reserved" | "unknown"
export type RouteNameGrant = { handle: string; token: string }

/** The probe cannot identify a reservation holder. */
export function nameIsUnavailable(
  status: NameAvailability,
  { resuming, allowBlocked = false }: { resuming: boolean; allowBlocked?: boolean },
): boolean {
  const blocked = status === "blocked" || status === "blocked-reserved"
  const reserved = status === "reserved" || status === "blocked-reserved"
  return (blocked && !allowBlocked) || (reserved && !resuming)
}

const DEBOUNCE_MS = 350
// A type-ahead spinner must not outlast the user's patience on a dead network.
const TIMEOUT_MS = 2000

function isStatus(value: unknown): value is "available" | "reserved" | "blocked" {
  return value === "available" || value === "reserved" || value === "blocked"
}

/** Credential-free: the probe is an open route, and typing a name must not need keys. */
const accountServiceReader = (config: ReturnType<typeof getConfig>) =>
  new AccountServiceClient(config.accountServiceUrl, { readOnly: true, timeoutMs: TIMEOUT_MS })

export type NameProbe = { status: NameAvailability; grantValid: boolean; grantBound: boolean }

async function readAvailability(handle: string, grantToken?: string) {
  const bare = normalizeTag(handle)
  if (bare === null) throw new Error("Invalid tag")
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  const nameHash = composeWireNameHash(bare, requireTupleField(tuple, "ensDomain"))
  return accountServiceReader(config).availableNameDetails(nameHash, grantToken)
}

/** A route grant is usable until revoked, including after it is bound to a passkey. */
export async function routeGrantIsCurrent(handle: string, token: string): Promise<boolean> {
  const details = await readAvailability(handle, token)
  if (!isStatus(details.status)) throw new Error("Invalid name availability status")
  return details.grantValid === true || details.grantBound === true
}

/** Fold the tag before probing; failures read as unknown with no validated grant. */
export async function probeNameAvailability(
  handle: string,
  grantToken?: string,
): Promise<NameProbe> {
  const unknown: NameProbe = { status: "unknown", grantValid: false, grantBound: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  // The client's read retries would stretch the per-request timeout to several seconds.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Name availability timed out")), TIMEOUT_MS)
  })
  try {
    const { status, blocked, grantValid, grantBound } = await Promise.race([
      readAvailability(handle, grantToken),
      deadline,
    ])
    if (!isStatus(status)) return unknown
    const availability =
      status === "reserved" && blocked ? "blocked-reserved" : blocked ? "blocked" : status
    return {
      status: availability,
      grantValid: grantValid === true,
      grantBound: grantBound === true,
    }
  } catch {
    return unknown
  } finally {
    clearTimeout(timer)
  }
}

/** A tag's answer, plus whether one is still being worked out. */
export type NameCheck = NameProbe & { checking: boolean }
type StoredNameCheck = NameCheck & { handle: string | null; grantToken?: string }

/**
 * Debounced probe of the tag being typed. `checking` covers the debounce and the request together,
 * so the caller shows one uninterrupted spinner rather than blinking between the two; `status`
 * stays "unknown" until an answer lands. The cleanup drops both the pending debounce and a reply
 * that arrives after the tag moved on.
 */
export function useNameAvailability(
  handle: string,
  enabled: boolean,
  grantToken?: string,
): NameCheck {
  const [check, setCheck] = useState<StoredNameCheck>({
    handle: null,
    status: "unknown",
    checking: false,
    grantValid: false,
    grantBound: false,
  })
  useEffect(() => {
    if (!enabled || normalizeTag(handle) === null) {
      setCheck({
        handle: null,
        status: "unknown",
        checking: false,
        grantValid: false,
        grantBound: false,
      })
      return
    }
    setCheck({
      handle,
      grantToken,
      status: "unknown",
      checking: true,
      grantValid: false,
      grantBound: false,
    })
    let live = true
    const timer = setTimeout(() => {
      void probeNameAvailability(handle, grantToken).then((result) => {
        if (live) setCheck({ handle, grantToken, ...result, checking: false })
      })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [handle, enabled, grantToken])
  if (!enabled || normalizeTag(handle) === null)
    return { status: "unknown", checking: false, grantValid: false, grantBound: false }
  // A seeded tag and a just-edited tag must wait even before the effect schedules their probe.
  if (check.handle !== handle || check.grantToken !== grantToken)
    return { status: "unknown", checking: true, grantValid: false, grantBound: false }
  return {
    status: check.status,
    checking: check.checking,
    grantValid: check.grantValid,
    grantBound: check.grantBound,
  }
}
