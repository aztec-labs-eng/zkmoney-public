import { DEVICE_KEYS, type DeviceState } from "../../platform/storage/deviceKeys"
import { linkIdentity } from "./linkIdentity"
import type { TicketDevice } from "./ticketSignupAccount"

/**
 * Links whose golden ticket the claim server refused as spent, by identity, never the bearer
 * fragment. Only this browser's own refusals are known: nothing public says whether a ticket is
 * spent, so a ticket spent elsewhere still reads as available until its redeem is refused.
 */
function identityOf(fragment: string): string | null {
  try {
    return linkIdentity(fragment)
  } catch {
    return null
  }
}

function spentIds(raw: string | null | undefined): string[] {
  try {
    const ids = JSON.parse(raw ?? "[]")
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

export async function rememberTicketSpent(own: TicketDevice, fragment: string): Promise<void> {
  const id = identityOf(fragment)
  if (!id) return
  await own.database.write(async (w) => {
    const key = DEVICE_KEYS.ticketSpent
    w.put(key, JSON.stringify([...new Set([...spentIds(await w.get(key)), id])]))
  })
}

/** The link's ticket is known spent: it is treated as a link with no ticket. */
export function ticketKnownSpent(device: DeviceState, fragment: string): boolean {
  const id = identityOf(fragment)
  return id !== null && spentIds(device.ticketSpent).includes(id)
}
