/**
 * Whether the deployment this wallet runs against has a frozen portal. A frozen portal means its
 * rollup is retired: the wallet then opens only the frozen-refund exit. Freezing is final, so the
 * read stops once it sees one.
 */
import { useSyncExternalStore } from "react"
import type { Address } from "viem"
import { isPortalFrozen } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient } from "../../config/oxideTuple"

const POLL_MS = 60_000

let frozen = false
let polling = false
const listeners = new Set<() => void>()

/** Reads the portal until it is seen frozen; from then on answers from memory. */
export async function readPortalFrozen(): Promise<boolean> {
  if (frozen) return true
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  if (await isPortalFrozen(l1PublicClient(config), tuple.portal as Address)) {
    frozen = true
    listeners.forEach((listener) => listener())
  }
  return frozen
}

async function poll() {
  if (await readPortalFrozen().catch(() => false)) return
  setTimeout(() => void poll(), POLL_MS)
}

/** The last read, for code outside React. */
export const portalFrozenNow = () => frozen

/** Calls `listener` once the portal is seen frozen. */
export function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!polling) {
    polling = true
    void poll()
  }
  return () => {
    listeners.delete(listener)
  }
}

export function usePortalFrozen(): boolean {
  return useSyncExternalStore(subscribe, () => frozen)
}
