import type { Address } from "viem"
import { ensNameOf, looksLikeEnsName } from "../core/services/ens"
import type { QueryEntry } from "../engine/query"
import { useLookup } from "./useLookup"

export type EnsLookup =
  | { name?: undefined }
  | { name: string; state: "resolving" | "missing" | "invalid" | "error"; address?: undefined }
  | { name: string; state: "found"; address: Address }

/**
 * Resolves `text` when it is an ENS name, 300 ms after it stops changing. `addresses` is never
 * fresh, so every new entry of a name looks it up again and a stealth name never reuses an address.
 */
export function useEnsAddress(
  text: string,
  addresses: (name: string) => QueryEntry<Address | null>,
): EnsLookup {
  const name = ensNameOf(text)
  const lookup = useLookup(name, addresses, { delayMs: 300 })
  if (!name) return looksLikeEnsName(text) ? { name: text, state: "invalid" } : {}
  if (lookup.status === "failed") return { name, state: "error" }
  if (lookup.status !== "answered") return { name, state: "resolving" }
  if (lookup.value === null) return { name, state: "missing" }
  return { name, state: "found", address: lookup.value }
}
