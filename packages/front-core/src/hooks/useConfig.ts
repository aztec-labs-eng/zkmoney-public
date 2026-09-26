import { useCallback, useRef, useSyncExternalStore } from "react"
import type { LocalConfig } from "@obsidion/core/types"
import { useLocalConfigStore } from "../contexts/useConfigContext"

type ConfigKey = keyof LocalConfig

interface SelectionCache {
  keys: readonly ConfigKey[]
  source: LocalConfig
  picked: Partial<LocalConfig>
}

const sameKeyList = (a: readonly ConfigKey[], b: readonly ConfigKey[]) =>
  a.length === b.length && a.every((key, i) => key === b[i])

/**
 * Subscribe to the whole config, or to a subset of keys. The keyed form only
 * re-renders when one of the selected values changes.
 */
export function useConfig(): LocalConfig
export function useConfig<K extends ConfigKey>(keys: readonly K[]): Pick<LocalConfig, K>
export function useConfig(keys?: readonly ConfigKey[]): Partial<LocalConfig> {
  const service = useLocalConfigStore()
  // useSyncExternalStore requires the snapshot function to return a cached
  // object: a fresh Pick per call would read as "changed" every render and loop.
  const cacheRef = useRef<SelectionCache | null>(null)
  const getSelection = (): Partial<LocalConfig> => {
    const source = service.getSnapshot()
    if (!keys) return source
    const cache = cacheRef.current
    const cacheKeysMatch = cache !== null && sameKeyList(cache.keys, keys)
    if (cacheKeysMatch && cache.source === source) return cache.picked
    const picked: Partial<LocalConfig> = {}
    for (const key of keys) picked[key] = source[key]
    if (cacheKeysMatch && keys.every((key) => Object.is(cache.picked[key], picked[key]))) {
      cacheRef.current = { keys, source, picked: cache.picked }
      return cache.picked
    }
    cacheRef.current = { keys, source, picked }
    return picked
  }
  return useSyncExternalStore(service.subscribe, getSelection)
}

export function useConfigValue<K extends ConfigKey>(
  key: K,
): { value: LocalConfig[K]; setValue: (value: LocalConfig[K]) => Promise<void> } {
  const service = useLocalConfigStore()
  const value = useSyncExternalStore(service.subscribe, () => service.get(key))
  const setValue = useCallback(
    (newValue: LocalConfig[K]) => service.set(key, newValue),
    [service, key],
  )
  return { value, setValue }
}

export const useDevMode = () => useConfigValue("devMode")
