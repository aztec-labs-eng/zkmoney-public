/** Live name policy and grant status while a tag is typed. `/domain/sign` remains authoritative. */
import {
  AccountServiceClient,
  composeWireNameHash,
  derived,
  lookup,
  normalizeTag,
  type QueryFactory,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { WalletError } from "@obsidion/core/errors"
import type { DrawnNameResponse } from "@obsidion/core/types"
import type { WebWalletConfig } from "../../config/env"
import { requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import type { SignupStash } from "./signupStash"

export type NameAvailability = "available" | "reserved" | "blocked" | "blocked-reserved" | "unknown"

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
const accountServiceReader = (config: WebWalletConfig) =>
  new AccountServiceClient(config.accountServiceUrl, { readOnly: true, timeoutMs: TIMEOUT_MS })

export type NameProbe = { status: NameAvailability; grantValid: boolean; grantBound: boolean }

async function readAvailability(page: PageFacts, handle: string, grantToken?: string) {
  const bare = normalizeTag(handle)
  if (bare === null) throw new WalletError("name.invalid", handle)
  const tuple = await page.chain.oxideTuple.read()
  const nameHash = composeWireNameHash(bare, requireTupleField(tuple, "ensDomain"))
  return accountServiceReader(page.config).availableNameDetails(nameHash, grantToken)
}

/** A tag the claim server draws for a visitor with no passkey yet, with the grant its claim spends. */
export async function drawTag({ config, chain }: PageFacts): Promise<DrawnNameResponse> {
  const tuple = await chain.oxideTuple.read()
  return new AccountServiceClient(config.accountServiceUrl, { readOnly: true }).drawName(
    requireTupleField(tuple, "ensDomain"),
  )
}

/** A route grant is usable until revoked, including after it is bound to a passkey. */
export async function routeGrantIsCurrent(page: PageFacts, handle: string, token: string) {
  const details = await readAvailability(page, handle, token)
  if (!isStatus(details.status)) throw new WalletError("name.statusUnread", String(details.status))
  return details.grantValid === true || details.grantBound === true
}

/** Fold the tag before probing; failures read as unknown with no validated grant. */
export async function probeNameAvailability(
  page: PageFacts,
  handle: string,
  grantToken?: string,
): Promise<NameProbe> {
  const unknown: NameProbe = { status: "unknown", grantValid: false, grantBound: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  // The client's read retries would stretch the per-request timeout to several seconds.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WalletError("timeout", "Name availability timed out")),
      TIMEOUT_MS,
    )
  })
  try {
    const { status, blocked, grantValid, grantBound } = await Promise.race([
      readAvailability(page, handle, grantToken),
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

/** A tag to probe, with the grant its probe validates. */
export interface NameKey {
  handle: string
  grantToken?: string
}

const UNKNOWN: NameProbe = { status: "unknown", grantValid: false, grantBound: false }

/** What a tag probe reads: the page's facts and its query constructor. */
export type ProbePage = PageFacts & { query: QueryFactory }

/**
 * The probe of the tag being typed; `key` is undefined while there is nothing to check. `check`
 * reads "checking" from a key's change until its own answer lands, so the debounce and the request
 * show as one spinner. Each typed tag is probed afresh. `start` probes until `signal` aborts.
 */
export function nameCheck(page: ProbePage, key: ReadonlyStore<NameKey | undefined>) {
  const same = (a?: NameKey, b?: NameKey) =>
    a?.handle === b?.handle && a?.grantToken === b?.grantToken
  const stable = derived([key], (k) => k, same)
  const probes = page.query<[string, string | undefined], NameProbe>("nameProbe", {
    load: (handle, grantToken) => probeNameAvailability(page, handle, grantToken),
    stale: 0,
  })
  const probe = lookup(stable, (k) => probes(k.handle, k.grantToken), { delayMs: DEBOUNCE_MS })
  const answer = derived([probe], (p) =>
    p.status === "answered" && p.key ? { key: p.key, probe: p.value } : undefined,
  )
  const check = derived(
    [stable, answer],
    (k, a): NameCheck =>
      a && same(a.key, k) ? { ...a.probe, checking: false } : { ...UNKNOWN, checking: !!k },
  )
  return {
    check,
    /** The last answer, with the key it answers; unset while a probe is due. */
    answer,
    start(signal: AbortSignal) {
      const off = probe.subscribe(() => {})
      signal.addEventListener("abort", off)
    },
  }
}

/** A tag step's field: what is typed, its folded tag, the route grant for it, and its check. */
export type TagField = NameCheck & { typed: string; handle: string | null; grantToken?: string }

/**
 * The tag field over what is typed. A stashed grant rides along for the route's own tag, and the
 * tag is probed while `probing` holds of `state`.
 */
export function tagField<S>(
  page: ProbePage,
  typed: ReadonlyStore<string>,
  { signup, routeHandle }: { signup: Pick<SignupStash, "state">; routeHandle?: string },
  state: ReadonlyStore<S>,
  probing: (state: S) => boolean,
) {
  const entry = derived([typed, signup.state], (text, { grant }) => {
    const handle = normalizeTag(text)
    const routed = handle !== null && handle === routeHandle && grant?.handle === handle
    return { typed: text, handle, grantToken: routed ? grant.token : undefined }
  })
  const names = nameCheck(
    page,
    derived([entry, state], ({ handle, grantToken }, s) =>
      handle !== null && probing(s) ? { handle, grantToken } : undefined,
    ),
  )
  const field = derived([entry, names.check], (e, check): TagField => ({ ...e, ...check }))
  return { field, start: names.start }
}

export interface TagRule {
  resuming: boolean
  boundGrantOwner: boolean
  /** The step's payment cannot cover the account yet. */
  held?: boolean
}

/**
 * What a tag step offers on its field. The probe knows a tag is held, never by whom: a resume may
 * continue through its own hold, and only a live route grant through the blocklist.
 */
export function tagSubmit(
  { handle, grantToken, status, checking, grantValid, grantBound }: TagField,
  { resuming, boundGrantOwner, held = false }: TagRule,
) {
  const recoverBoundGrant = Boolean(grantToken && grantBound && !boundGrantOwner)
  const allowBlocked = Boolean(grantToken && (grantValid || (grantBound && boundGrantOwner)))
  const grantUnverified = Boolean(grantToken && status === "unknown" && !checking)
  const taken = nameIsUnavailable(status, { resuming, allowBlocked })
  const valid = handle !== null
  const submittable =
    valid && (!taken || recoverBoundGrant) && !checking && !grantUnverified && !held
  return { valid, recoverBoundGrant, allowBlocked, grantUnverified, submittable }
}
