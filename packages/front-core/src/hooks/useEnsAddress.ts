import { useEffect, useState } from "react"
import type { Address } from "viem"
import {
  ensNameOf,
  looksLikeEnsName,
  lookupEnsAddress,
  type GetEnsClient,
} from "../core/services/ens"

export type EnsLookup =
  | { name?: undefined }
  | { name: string; state: "resolving" | "missing" | "invalid" | "error"; address?: undefined }
  | { name: string; state: "found"; address: Address }

/**
 * Resolves `text` when it is an ENS name, 300 ms after it stops changing. Every new entry of a name
 * looks it up afresh and reads as resolving until then, so a stealth name never reuses an address.
 */
export function useEnsAddress(text: string, getClient: GetEnsClient): EnsLookup {
  const name = ensNameOf(text)
  const [result, setResult] = useState<Address | null | "error">()
  const [lookedUp, setLookedUp] = useState(name)
  if (lookedUp !== name) {
    setLookedUp(name)
    setResult(undefined)
  }
  useEffect(() => {
    if (!name) return
    let live = true
    const timer = setTimeout(() => {
      lookupEnsAddress(getClient, name).then(
        (address) => live && setResult(address),
        () => live && setResult("error"),
      )
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [name, getClient])
  if (!name) return looksLikeEnsName(text) ? { name: text, state: "invalid" } : {}
  if (result === undefined) return { name, state: "resolving" }
  if (result === null) return { name, state: "missing" }
  if (result === "error") return { name, state: "error" }
  return { name, state: "found", address: result }
}
