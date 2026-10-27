import { useEffect, useState } from "react"
import { ContactStorage, type RegistryTagResolution } from "@obsidion/front-core"
import { resolveTagViaRegistry } from "./registryResolution"

const resolutions = new Map<string, Promise<RegistryTagResolution | undefined>>()

/** Shares a read still running; each list visit reads again. A failed read gives undefined. */
function resolve(tag: string): Promise<RegistryTagResolution | undefined> {
  let read = resolutions.get(tag)
  if (!read) {
    read = resolveTagViaRegistry(tag)
      .catch(() => undefined)
      .finally(() => resolutions.delete(tag))
    resolutions.set(tag, read)
  }
  return read
}

/**
 * The tags among `tags` still on a retired rollup. A contact carried over from one keeps its old
 * address until its tag resolves here; then the book takes the new one.
 */
export function useNotUpgradedTags(tags: readonly string[]): ReadonlySet<string> {
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set())
  const key = [...new Set(tags.map((t) => t.toLowerCase()))].sort().join("\n")
  useEffect(() => {
    if (!key) return
    let live = true
    void Promise.all(
      key.split("\n").map(async (tag) => {
        const resolution = await resolve(tag)
        if (resolution?.status === "resolved") {
          await ContactStorage.get()
            .updateL2Address(tag, resolution.l2Address)
            .catch(() => undefined)
        }
        return resolution?.status === "staleRollup" ? tag : undefined
      }),
    ).then((found) => live && setStale(new Set(found.filter((t) => t !== undefined))))
    return () => {
      live = false
    }
  }, [key])
  return stale
}
