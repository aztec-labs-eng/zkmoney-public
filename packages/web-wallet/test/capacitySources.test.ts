import { describe, expect, it, vi } from "vitest"
import type { PortalCapacityKey } from "@obsidion/front-core"
import { sourceFromSipaKey, sourceFromTarget } from "../src/features/limits/capacitySources"

const ORIGINAL: PortalCapacityKey = { chainId: 1, portal: "0xoriginal", token: "0xdai" }

describe("sourceFromTarget", () => {
  it("maps each address resolution to a source that never names the active bucket unasked", () => {
    const retry = vi.fn()
    expect(sourceFromTarget({ resolution: "resolved", key: ORIGINAL, retry })).toEqual({
      kind: "key",
      key: ORIGINAL,
    })
    expect(sourceFromTarget({ resolution: "pending", retry })).toEqual({ kind: "pending" })
    expect(sourceFromTarget({ resolution: "resolved", retry })).toEqual({ kind: "pending" })
    // A failed read of the original terms retries through the address's own reader.
    expect(sourceFromTarget({ resolution: "failed", retry })).toEqual({ kind: "unresolved", retry })
    // Nothing proves the portal (an embedded request address, a record with no origin): no retry.
    expect(sourceFromTarget({ resolution: "missing", retry })).toEqual({ kind: "unresolved" })
  })
})

describe("sourceFromSipaKey", () => {
  it("maps a recorded deposit's key, keeping Retry only for a failed lookup", () => {
    const retry = vi.fn()
    expect(sourceFromSipaKey({ status: "known", key: ORIGINAL }, retry)).toEqual({
      kind: "key",
      key: ORIGINAL,
    })
    expect(sourceFromSipaKey({ status: "pending" }, retry)).toEqual({ kind: "pending" })
    expect(sourceFromSipaKey({ status: "unknown", retryable: true }, retry)).toEqual({
      kind: "unresolved",
      retry,
    })
    expect(sourceFromSipaKey({ status: "unknown", retryable: false }, retry)).toEqual({
      kind: "unresolved",
    })
    // No observer yet (boot, plain demo): not a known bucket.
    expect(sourceFromSipaKey(undefined, retry)).toEqual({ kind: "unresolved" })
  })
})
