import { describe, expect, it } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { retiredIdentityGenerations } from "../../src/oxide/retiredIdentityGenerations"

const tuple = (over: Partial<OxideEnvTuple>): OxideEnvTuple =>
  ({
    version: "retired",
    gitSha: "",
    timestamp: "2026-09-01T00:00:00.000Z",
    deployedAt: "2026-09-01T00:00:00.000Z",
    portal: "0x00000000000000000000000000000000000000a0",
    token: "0x6b9ef1a089feeff90695ac7cf19be39f4b8a0334",
    l2Token: `0x${"11".repeat(32)}`,
    enclaveUrl: "https://tee.example.test/rpc",
    pcr0: "",
    rollupVersion: "6",
    accountFactory: "0x842f0f87bf2318fe7b68a516e360cd1fded36c9b",
    namePortal: "0x5555555555555555555555555555555555555555",
    ...over,
  }) as OxideEnvTuple

describe("retiredIdentityGenerations", () => {
  it("maps a retired deployment's static fields into one admission candidate", () => {
    const generations = retiredIdentityGenerations([tuple({})])
    expect(generations).toEqual([
      {
        fpcAddress: expect.stringMatching(/^0x[0-9a-fA-F]{64}$/),
        accountFactory: "0x842f0f87bf2318fe7b68a516e360cd1fded36c9b",
        namePortal: "0x5555555555555555555555555555555555555555",
        rollupVersion: "6",
      },
    ])
  })

  it("derives the same placeholder address from the same tuple", () => {
    const [first] = retiredIdentityGenerations([tuple({})])
    const [second] = retiredIdentityGenerations([tuple({})])
    expect(first.fpcAddress).toBe(second.fpcAddress)
  })

  it("skips an entry missing accountFactory or namePortal", () => {
    expect(retiredIdentityGenerations([tuple({ accountFactory: undefined })])).toEqual([])
    expect(retiredIdentityGenerations([tuple({ namePortal: undefined })])).toEqual([])
  })
})
