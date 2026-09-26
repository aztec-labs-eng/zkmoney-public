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

const keyFor = (rpId: string, paylinkId: string) =>
  `obsidion.ticket-signup.account:${rpId}:${paylinkId}`

export const isTicketSignupCreating = (
  attempt: TicketSignupAttempt | null,
): attempt is TicketSignupCreating => attempt !== null && "phase" in attempt

export function loadTicketSignupAttempt(
  rpId: string,
  paylinkId: string,
): TicketSignupAttempt | null {
  const raw = localStorage.getItem(keyFor(rpId, paylinkId))
  if (raw === null) return null
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
      throw new Error("invalid account binding")
    return {
      credentialId: record.credentialId,
      l2Address: record.l2Address,
      ...(record.tag !== undefined ? { tag: record.tag } : {}),
    }
  } catch {
    throw new Error(
      "This payment already has a signup whose account could not be read. Sign in to that account to continue.",
    )
  }
}

/** An incomplete attempt must never be mistaken for a fresh signup. */
export function loadTicketSignupAccount(
  rpId: string,
  paylinkId: string,
): TicketSignupAccount | null {
  const attempt = loadTicketSignupAttempt(rpId, paylinkId)
  if (isTicketSignupCreating(attempt))
    throw new Error(
      "The previous passkey attempt did not finish saving. Restart it explicitly to create another passkey.",
    )
  return attempt
}

/** Refuse creation unless its intent can be saved before opening the authenticator. */
export function beginTicketSignupAccount(
  rpId: string,
  paylinkId: string,
  tag: string,
): TicketSignupCreating {
  if (loadTicketSignupAttempt(rpId, paylinkId))
    throw new Error("This payment already has a signup. Continue that signup first.")
  const attempt: TicketSignupCreating = { phase: "creating", attemptId: crypto.randomUUID(), tag }
  localStorage.setItem(keyFor(rpId, paylinkId), JSON.stringify(attempt))
  return attempt
}

/** A late completion cannot replace an attempt the user explicitly restarted. */
export function completeTicketSignupAccount(
  rpId: string,
  paylinkId: string,
  attemptId: string,
  account: TicketSignupAccount,
): void {
  const attempt = loadTicketSignupAttempt(rpId, paylinkId)
  if (!isTicketSignupCreating(attempt) || attempt.attemptId !== attemptId)
    throw new Error("This signup attempt is no longer active.")
  saveTicketSignupAccount(rpId, paylinkId, { ...account, tag: attempt.tag })
}

/**
 * Only the interrupted attempt the caller saw can be explicitly restarted. One another tab began
 * since may be mid-ceremony there, and a binding saved since is the account to continue with.
 */
export function restartTicketSignupAccount(
  rpId: string,
  paylinkId: string,
  attemptId: string,
): void {
  const attempt = loadTicketSignupAttempt(rpId, paylinkId)
  if (attempt !== null && !isTicketSignupCreating(attempt))
    throw new Error("This signup already has an account. Continue with its passkey.")
  if (attempt === null || attempt.attemptId !== attemptId)
    throw new Error("This signup attempt was restarted in another tab. Continue there.")
  localStorage.removeItem(keyFor(rpId, paylinkId))
}

/** Retained when the wizard closes: a redemption may already have bound the ticket to this account. */
export function saveTicketSignupAccount(
  rpId: string,
  paylinkId: string,
  account: TicketSignupAccount,
): void {
  localStorage.setItem(keyFor(rpId, paylinkId), JSON.stringify(account))
}
