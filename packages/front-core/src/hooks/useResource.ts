import { NO_SERVICE, type ServiceState } from "../engine/service"
import type { ReadonlyStore } from "../engine/store"
import { useStore } from "./useStore"

const held = <T>(state: ServiceState<T>): T | undefined =>
  state.status === "ready" ? state.value : undefined

/** A service's value once it is ready. */
export function useResource<T>(
  r: ReadonlyStore<ServiceState<T>> | null | undefined,
): T | undefined {
  return useStore<ServiceState<T>, T | undefined>(r ?? NO_SERVICE, held)
}
