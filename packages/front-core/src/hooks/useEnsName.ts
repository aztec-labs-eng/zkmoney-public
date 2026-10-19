import { useEffect, useState } from "react"
import type { Address } from "viem"
import { lookupEnsName, type GetEnsClient } from "../core/services/ens"

/** The address's ENS primary name, or null until one resolves (or when it has none). */
export function useEnsName(address: string | undefined, getClient: GetEnsClient): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    setName(null)
    if (!address) return
    let live = true
    void lookupEnsName(getClient, address as Address).then((n) => live && setName(n))
    return () => {
      live = false
    }
  }, [address, getClient])
  return name
}
