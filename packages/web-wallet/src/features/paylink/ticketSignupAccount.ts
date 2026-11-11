import { WalletError, type Database, type ReadonlyStore } from "@obsidion/front-core"
import { TICKET_SIGNUP_PREFIX, type DeviceState } from "../../platform/storage/deviceKeys"

/** The page's device keys and the database they commit through. */
export interface TicketDevice {
  database: Database
  device: ReadonlyStore<DeviceState>
}

/** Public account binding for a ticket signup interrupted before its registration was saved. */
export interface TicketSignupAccount {
  credentialId: string
  l2Address: string
  tag?: string
}

export interface TicketSignupCreating {
  phase: "creating"
  attemptId: string
  tag: string
}

export type TicketSignupAttempt = TicketSignupAccount | TicketSignupCreating

const keyFor = (rpId: string, paylinkId: string) => `${TICKET_SIGNUP_PREFIX}${rpId}:${paylinkId}`

export const isTicketSignupCreating = (
  attempt: TicketSignupAttempt | null,
): attempt is TicketSignupCreating => attempt !== null && "phase" in attempt

/** The saved ticket signups; unknown, so a throw, until the device keys load. */
function signups(device: ReadonlyStore<DeviceState>): ReadonlyMap<string, string> {
  const state = device.get()
  if (!state.loaded) throw new WalletError("wallet.notReady")
  return state.ticketSignups
}

function parse(raw: string | undefined): TicketSignupAttempt | null {
  if (raw === undefined) return null
  try {
    const record = JSON.parse(raw)
    if (
      record.phase === "creating" &&
      typeof record.attemptId === "string" &&
      record.attemptId &&
      typeof record.tag === "string" &&
      record.tag
    ) {
      return { phase: "creating", attemptId: record.attemptId, tag: record.tag }
    }
    if (
      typeof record.credentialId !== "string" ||
      !record.credentialId ||
      !/^0x[0-9a-fA-F]{64}$/.test(record.l2Address) ||
      (record.tag !== undefined && typeof record.tag !== "string")
    )
      throw new Error("invalid account binding") // debt-check-ignore: moved verbatim; signup shows these words until its errors take codes
    return {
      credentialId: record.credentialId,
      l2Address: record.l2Address,
      ...(record.tag !== undefined ? { tag: record.tag } : {}),
    }
  } catch {
    throw new Error(
      "This payment already has a signup whose account could not be read. Sign in to that account to continue.", // debt-check-ignore: moved verbatim; signup shows these words until its errors take codes
    )
  }
}

export function loadTicketSignupAttempt(
  own: Pick<TicketDevice, "device">,
  rpId: string,
  paylinkId: string,
): TicketSignupAttempt | null {
  return parse(signups(own.device).get(keyFor(rpId, paylinkId)))
}

/** An incomplete attempt must never be mistaken for a fresh signup. */
export function loadTicketSignupAccount(
  own: Pick<TicketDevice, "device">,
  rpId: string,
  paylinkId: string,
): TicketSignupAccount | null {
  const attempt = loadTicketSignupAttempt(own, rpId, paylinkId)
  if (isTicketSignupCreating(attempt))
    throw new Error(
      "The previous passkey attempt did not finish saving. Restart it explicitly to create another passkey.",
    )
  return attempt
}

/** Refuse creation unless its intent is saved before the authenticator opens. */
export async function beginTicketSignupAccount(
  own: TicketDevice,
  rpId: string,
  paylinkId: string,
  tag: string,
): Promise<TicketSignupCreating> {
  const key = keyFor(rpId, paylinkId)
  return own.database.write(async (w) => {
    if (parse(await w.get(key)))
      throw new Error("This payment already has a signup. Continue that signup first.") // debt-check-ignore: moved verbatim; signup shows these words until its errors take codes
    const attempt: TicketSignupCreating = { phase: "creating", attemptId: crypto.randomUUID(), tag }
    w.put(key, JSON.stringify(attempt))
    return attempt
  })
}

/**
 * A late completion cannot replace an attempt the user explicitly restarted. Resolves once the
 * binding is saved: the ticket is spent on this account only after that.
 */
export async function completeTicketSignupAccount(
  own: TicketDevice,
  rpId: string,
  paylinkId: string,
  attemptId: string,
  account: TicketSignupAccount,
): Promise<void> {
  const key = keyFor(rpId, paylinkId)
  await own.database.write(async (w) => {
    const attempt = parse(await w.get(key))
    if (!isTicketSignupCreating(attempt) || attempt.attemptId !== attemptId)
      throw new Error("This signup attempt is no longer active.") // debt-check-ignore: moved verbatim; signup shows these words until its errors take codes
    w.put(key, JSON.stringify({ ...account, tag: attempt.tag }))
  })
}

/**
 * Only the interrupted attempt the caller saw can be explicitly restarted. One another tab began
 * since may be mid-ceremony there, and a binding saved since is the account to continue with.
 * Resolves once the attempt is gone.
 */
export async function restartTicketSignupAccount(
  own: TicketDevice,
  rpId: string,
  paylinkId: string,
  attemptId: string,
): Promise<void> {
  const key = keyFor(rpId, paylinkId)
  await own.database.write(async (w) => {
    const attempt = parse(await w.get(key))
    if (attempt !== null && !isTicketSignupCreating(attempt))
      throw new Error("This signup already has an account. Continue with its passkey.") // debt-check-ignore: moved verbatim; signup shows these words until its errors take codes
    if (attempt === null || attempt.attemptId !== attemptId)
      throw new Error("This signup attempt was restarted in another tab. Continue there.") // debt-check-ignore: moved verbatim; signup shows these words until its errors take codes
    w.remove(key)
  })
}

/** Retained when the wizard closes: a redemption may already have bound the ticket to this account. */
export function saveTicketSignupAccount(
  own: TicketDevice,
  rpId: string,
  paylinkId: string,
  account: TicketSignupAccount,
): Promise<void> {
  return own.database.write(async (w) => w.put(keyFor(rpId, paylinkId), JSON.stringify(account)))
}

/** A payment link's signup bound this passkey: only that link's signup continues its account. */
export function boundToTicketSignup(
  own: Pick<TicketDevice, "device">,
  rpId: string,
  credentialId: string,
): boolean {
  const prefix = keyFor(rpId, "")
  return [...signups(own.device)].some(([key, raw]) => {
    if (!key.startsWith(prefix)) return false
    try {
      return JSON.parse(raw)?.credentialId === credentialId
    } catch {
      return false
    }
  })
}
