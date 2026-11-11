/**
 * Receive's live code: one minted request per address, kept until it is paid. The address comes
 * ready from the deposit pool; with none ready the code carries no address until one is.
 */
import type { Address } from "viem"
import type { MintedRequestLink, ReceiveCode, ReceiveCodes } from "@obsidion/front-core"

const DAY_MS = 86_400_000

/** Oldest published address the code shows: the relayer stops waiting on an unfunded one soon after. */
export const CODE_ADDRESS_MAX_AGE_MS = 2 * DAY_MS

/** A request expires; the code is minted anew before the payer could find it expired. */
export const CODE_LIFETIME_MS = 7 * DAY_MS

export interface ReadyAddress {
  address: Address
  /** Chain epoch day it was derived on. */
  day: number
}

export interface CodeForm {
  amountInput: string
  noteInput: string
}

export interface CodeDeps {
  codes: ReceiveCodes
  /** The code's id: `<networkId>.<tag>`. */
  id: string
  /** The account's L2 address now; a code pinned to another one is replaced. */
  requester?: string
  readyAddress(): Promise<ReadyAddress | null>
  /** Mints and stores the request for the code. */
  mint(
    args: CodeForm & { sipaAddress?: Address; durationMs: number; now: number },
  ): Promise<MintedRequestLink>
  cancel(requestId: string): Promise<unknown>
  /** The code's request is fulfilled or its address took a deposit. */
  paid(code: ReceiveCode): Promise<boolean>
}

export const receiveCodeId = (networkId: string, tag: string) => `${networkId}.${tag}`

/**
 * Minted for another L2 address than the account's now: a backup passkey moves the account to a new
 * one, payers refuse a code pinned to the old, and its deposit address pays the old account. A code
 * that records no requester may carry no pin, so it counts as well.
 */
function mintedForOtherAccount(code: ReceiveCode, requester?: string): boolean {
  return !!requester && code.requester?.toLowerCase() !== requester.toLowerCase()
}

/** Expired, its address is too old to be swept, or minted for another account. */
export function codeIsStale(code: ReceiveCode, now: number, requester?: string): boolean {
  if (code.expiresAt <= now || mintedForOtherAccount(code, requester)) return true
  return code.day !== undefined && code.day <= (now - CODE_ADDRESS_MAX_AGE_MS) / DAY_MS
}

/**
 * Mints the code anew. An unpaid code it replaces is cancelled, so it leaves the requests list; a
 * paid one stays for its fulfillment.
 */
export async function replaceCode(
  deps: CodeDeps,
  previous: ReceiveCode | null,
  next: { ready: ReadyAddress | null; form: CodeForm; previousPaid?: boolean },
  now: number = Date.now(),
): Promise<ReceiveCode> {
  const minted = await deps.mint({
    ...next.form,
    sipaAddress: next.ready?.address,
    durationMs: CODE_LIFETIME_MS,
    now,
  })
  const code: ReceiveCode = {
    requestId: minted.row.id,
    url: minted.url,
    amount: minted.row.amount,
    note: minted.note,
    address: next.ready?.address,
    day: next.ready?.day,
    expiresAt: minted.row.expiresAt ?? now + CODE_LIFETIME_MS,
    requester: minted.row.requesterAddress,
  }
  await deps.codes.put(deps.id, code)
  if (previous && !next.previousPaid) await deps.cancel(previous.requestId)
  return code
}

const BLANK_FORM: CodeForm = { amountInput: "", noteInput: "" }

const formOf = (code: ReceiveCode | null): CodeForm => ({
  amountInput: code && code.amount > 0 ? String(code.amount) : "",
  noteInput: code?.note ?? "",
})

/**
 * The code to show: the stored one while it is good, else a new one with the same amount and note.
 * A code without an address takes one as soon as one is ready.
 */
export async function currentCode(deps: CodeDeps, now: number = Date.now()): Promise<ReceiveCode> {
  const code = await deps.codes.get(deps.id)
  // Paid while Receive was closed: its address is spent.
  if (code && (await deps.paid(code))) return nextCode(deps, code, now)
  const good = code && !codeIsStale(code, now, deps.requester) ? code : null
  if (good?.address) return good
  const ready = await deps.readyAddress()
  if (good && !ready) return good
  return replaceCode(deps, code, { ready, form: formOf(code) }, now)
}

/** The code Receive opens on: an amount or note from an earlier visit is cleared, the address kept. */
export async function openCode(deps: CodeDeps, now: number = Date.now()): Promise<ReceiveCode> {
  const code = await deps.codes.get(deps.id)
  if (!code || (code.amount === 0 && !code.note) || codeIsStale(code, now, deps.requester))
    return currentCode(deps, now)
  if (await deps.paid(code)) return nextCode(deps, code, now)
  return clearCode(deps, now)
}

/** Drops the code's amount and note, keeping its address; the code it replaces leaves the requests list. */
export function clearCode(deps: CodeDeps, now: number = Date.now()): Promise<ReceiveCode> {
  return setCodeAmount(deps, BLANK_FORM, now)
}

/** Puts an amount and note on the code, keeping its address while it is still the account's. */
export async function setCodeAmount(
  deps: CodeDeps,
  form: CodeForm,
  now: number = Date.now(),
): Promise<ReceiveCode> {
  const code = await deps.codes.get(deps.id)
  const ready =
    code?.address && code.day !== undefined && !mintedForOtherAccount(code, deps.requester)
      ? { address: code.address, day: code.day }
      : await deps.readyAddress()
  return replaceCode(deps, code, { ready, form }, now)
}

/** After a payment: the paid code's address is spent, so the next code takes a new one and no amount. */
export async function nextCode(
  deps: CodeDeps,
  paid: ReceiveCode,
  now: number = Date.now(),
): Promise<ReceiveCode> {
  const ready = await deps.readyAddress()
  return replaceCode(deps, paid, { ready, form: BLANK_FORM, previousPaid: true }, now)
}
