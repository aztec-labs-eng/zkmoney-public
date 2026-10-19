import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { EnsClient } from "../../src/core/services/ens"
import { useEnsName } from "../../src/hooks/useEnsName"

const named = () => ({ getEnsName: async () => "niallinio.eth" } as unknown as EnsClient)

describe("useEnsName", () => {
  it("answers the address's primary name once it resolves", async () => {
    const { result } = renderHook(() => useEnsName(`0x${"8".repeat(40)}`, named))
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe("niallinio.eth"))
  })
})
