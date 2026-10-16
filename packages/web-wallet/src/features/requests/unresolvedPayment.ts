/**
 * A request payment this browser sent or approved, with nothing here to show it settled. The pay sheet holds until the
 * payer chooses to pay again. The payer may have no account, so the marker is a device key, one entry per payee
 * address: saved before a desktop approval, and with the hash once a wallet returns one.
 */
import type { Address } from "viem"
import { deviceStorage } from "../../platform/storage/rollupStorage"
import { UnresolvedSendStorageError } from "../deposit/unresolvedSend"

const STORAGE_KEY = "webwallet.unresolved-payments"

type Held = Record<string, { at: number; submission: string }>

const entry = (network: string, address: Address) => `${network}:${address.toLowerCase()}`

function read(): Held {
  try {
    const parsed = JSON.parse(deviceStorage.getItem(STORAGE_KEY) ?? "{}") as unknown
    return parsed && typeof parsed === "object" ? (parsed as Held) : {}
  } catch {
    return {}
  }
}

function write(held: Held): void {
  const value = JSON.stringify(held)
  if (Object.keys(held).length === 0) deviceStorage.removeItem(STORAGE_KEY)
  else deviceStorage.setItem(STORAGE_KEY, value)
}

export function paymentHeld(network: string, address: Address): boolean {
  return entry(network, address) in read()
}

/** Throws `UnresolvedSendStorageError` unless the marker is saved, so nothing is approved without it. */
export function holdPayment(network: string, address: Address, submission: string): void {
  try {
    write({ ...read(), [entry(network, address)]: { at: Date.now(), submission } })
  } catch (err) {
    throw new UnresolvedSendStorageError(err)
  }
  if (!paymentHeld(network, address)) throw new UnresolvedSendStorageError()
}

/** With `submission`, only that approval's marker goes. */
export function clearPayment(network: string, address: Address, submission?: string): void {
  const held = read()
  const key = entry(network, address)
  if (!held[key] || (submission && held[key].submission !== submission)) return
  delete held[key]
  try {
    write(held)
  } catch (err) {
    console.warn("[pay] could not remove the unresolved payment", err)
  }
}
