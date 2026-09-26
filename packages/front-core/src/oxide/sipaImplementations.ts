/**
 * The intent implementations a portal's SIPAs clone, memoized.
 *
 * `SIPAFactory` keys its pointers on the portal and writes each slot once, so the answer is fixed
 * for as long as the portal lives and one read serves every caller. The portal — not the manifest's
 * `depositSIPAImplementation` / `registrationSIPAImplementation` — is what a new derivation follows,
 * so a fee read against it can never disagree with the sweep the address it priced will get.
 * Retired generations are the historic probe's job and must not read these.
 *
 * A failed read is evicted: a settled rejection kept here would wedge every later caller on one
 * transient RPC error. A portal with no implementation throws rather than resolving zero (the sdk
 * reads fail closed), so nothing here caches an address a deposit could never be swept from.
 */

import type { Address, PublicClient } from "viem"
import { readDepositSIPAImplementation, readRegistrationSIPAImplementation } from "@obsidion/sdk"

type Read = (publicClient: PublicClient, sipaFactory: Address, portal: Address) => Promise<Address>

function memoize(read: Read): Read {
  const cache = new Map<string, Promise<Address>>()
  return (publicClient, sipaFactory, portal) => {
    const key = `${sipaFactory.toLowerCase()}:${portal.toLowerCase()}`
    const cached = cache.get(key)
    if (cached) return cached
    const pending = read(publicClient, sipaFactory, portal)
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key)
    })
    cache.set(key, pending)
    return pending
  }
}

/** `SIPAFactory.implementationFor(portal, Deposit)`. */
export const depositSipaImplementation = memoize(readDepositSIPAImplementation)

/** `SIPAFactory.implementationFor(portal, Registration)`. */
export const registrationSipaImplementation = memoize(readRegistrationSIPAImplementation)
