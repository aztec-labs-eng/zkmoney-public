import type { Address } from "viem"
import type { EnsNames } from "../core/services/ens"
import type { QueryState } from "../engine/query"
import { memoryStore } from "../engine/store"
import { useStore } from "./useStore"

const NO_ADDRESS = memoryStore<QueryState<string | null>>({ status: "pending" }).readonly

const nameOf = (state: QueryState<string | null>) => (state.status === "ready" ? state.value : null)

/** The address's ENS primary name, or null until one resolves (or when it has none). */
export function useEnsName(address: string | undefined, names: EnsNames): string | null {
  return useStore(address ? names(address as Address) : NO_ADDRESS, nameOf)
}
