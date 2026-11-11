/**
 * A request payment this browser sent or approved, with nothing here to show it settled. The pay
 * sheet holds until the payer chooses to pay again. The payer may have no account, so the hold is
 * page device state, one entry per payee address, saved before a desktop approval or a browser
 * wallet's prompt. Another send's hold refuses a new one until the payer chooses to pay again.
 */
import { WalletError, type Database } from "@obsidion/front-core"
import type { Address } from "viem"
import {
  DEVICE_KEYS,
  type DeviceState,
  type UnresolvedPayments,
} from "../../platform/storage/deviceKeys"

const entry = (network: string, address: Address) => `${network}:${address.toLowerCase()}`

export const paymentHeld = (state: DeviceState, network: string, address: Address): boolean =>
  state.unresolvedPayments.has(entry(network, address))

/** One commit over the saved holds; `change` returns undefined to leave them. */
function change(
  db: Database,
  next: (held: UnresolvedPayments) => UnresolvedPayments | undefined,
): Promise<void> {
  return db.write(async (w) => {
    const raw = await w.get(DEVICE_KEYS.unresolvedPayments)
    const held = next(new Map(Object.entries(raw ? (JSON.parse(raw) as object) : {})))
    if (!held) return
    if (held.size === 0) w.remove(DEVICE_KEYS.unresolvedPayments)
    else w.put(DEVICE_KEYS.unresolvedPayments, JSON.stringify(Object.fromEntries(held)))
  })
}

/** Resolves once the hold is saved, so nothing is approved without it. */
export async function holdPayment(
  db: Database,
  network: string,
  address: Address,
  submission: string,
): Promise<void> {
  const key = entry(network, address)
  let other = false
  try {
    await change(db, (held) => {
      const saved = held.get(key)
      other = !!saved && saved.submission !== submission
      return other ? undefined : new Map(held).set(key, { at: Date.now(), submission })
    })
  } catch (err) {
    throw new WalletError("deposit.holdUnsaved", undefined, { cause: err })
  }
  if (other) throw new WalletError("deposit.sendHeld")
}

/** With `submission`, only that approval's hold goes. */
export function clearPayment(
  db: Database,
  network: string,
  address: Address,
  submission?: string,
): Promise<void> {
  return change(db, (held) => {
    const key = entry(network, address)
    const saved = held.get(key)
    if (!saved || (submission && saved.submission !== submission)) return undefined
    const next = new Map(held)
    next.delete(key)
    return next
  })
}
