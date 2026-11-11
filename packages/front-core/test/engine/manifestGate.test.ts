// @vitest-environment node
import { describe, expect, it } from "vitest"
import { Network, type ContractService } from "@obsidion/sdk"
import { manifestGate } from "../../src/engine/contractService"
import { fixed } from "../../src/engine/service"

const service = (network: Network, failureMode: string | null, tuple: object | null = null) =>
  fixed("contractService", {
    getNetwork: () => network,
    getOxideClient: () => ({
      initialize: async () => {},
      getCurrentTuple: () => tuple,
      getResolutionState: () => ({ failureMode }),
    }),
  } as unknown as ContractService)

describe("the manifest gate", () => {
  it("fails on a mainnet manifest the client refused", async () => {
    const gate = manifestGate(service(Network.MAINNET, "manifest-incompatible"))
    await expect(gate.ready()).rejects.toMatchObject({ code: "config.invalid" })
  })

  it("passes a failed fetch, an applied tuple, and every other network", async () => {
    for (const cs of [
      service(Network.MAINNET, "fetch-failed"),
      service(Network.MAINNET, "manifest-incompatible", {}),
      service(Network.TESTNET, "manifest-incompatible"),
      fixed("contractService", { getOxideClient: () => null } as unknown as ContractService),
    ])
      await expect(manifestGate(cs).ready()).resolves.toBe(true)
  })
})
