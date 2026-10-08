/**
 * Maps the capacity bucket a surface already knows onto an About limits source. The address surfaces
 * name it with `useTargetCapacity`; a recorded deposit's sheets take it from the processing observer.
 * Neither mapping derives a key or falls back to the active deployment.
 */
import type { SipaCapacityKey } from "@obsidion/front-core"
import type { TargetCapacity } from "../deposit/targetCapacity"
import type { CapacitySource } from "./useAboutLimitsCapacity"

export function sourceFromTarget(
  capacity: Pick<TargetCapacity, "resolution" | "key" | "retry">,
): CapacitySource {
  switch (capacity.resolution) {
    case "resolved":
      return capacity.key ? { kind: "key", key: capacity.key } : { kind: "pending" }
    case "pending":
      return { kind: "pending" }
    case "failed":
      return { kind: "unresolved", retry: capacity.retry }
    case "missing":
      return { kind: "unresolved" }
  }
}

/** `key` is undefined before the observer exists (boot, plain demo); that is not a known bucket. */
export function sourceFromSipaKey(
  key: SipaCapacityKey | undefined,
  retry: () => void,
): CapacitySource {
  if (key?.status === "known") return { kind: "key", key: key.key }
  if (key?.status === "pending") return { kind: "pending" }
  if (key?.status === "unknown" && key.retryable) return { kind: "unresolved", retry }
  return { kind: "unresolved" }
}
