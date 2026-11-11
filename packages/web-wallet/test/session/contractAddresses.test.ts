// @vitest-environment node
/** A failed address read fails the load, so the next read asks again instead of keeping a gap. */
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it } from "vitest"
import { fixed, memoryStore, queries } from "@obsidion/front-core"
import type { ContractService, ObsidionWallet } from "@obsidion/sdk"
import { contractAddresses } from "../../src/session/contractAddresses"

const ADDRESS = "0x2a"

/** Fails `getContractAddress` or `getNodeInfo` once, as `failing` names, then answers. */
function world(failing: "l2" | "node") {
  let fail = true
  const answer = async () => {
    if (!fail) return { toString: () => ADDRESS }
    fail = false
    throw new Error("down")
  }
  const contractService = {
    getOxideClient: () => null,
    getContractAddress: failing === "l2" ? answer : async () => ({ toString: () => ADDRESS }),
  } as unknown as ContractService
  const nodeInfo = async () => ({
    l1ContractAddresses: { rollupAddress: await (failing === "node" ? answer() : ADDRESS) },
    protocolContractAddresses: {},
  })
  const node = { getNodeInfo: nodeInfo } as unknown as ObsidionWallet["node"]
  const query = queries({
    pace: createPace({ signalled: false }),
    visible: memoryStore(true).readonly,
    now: () => Date.now(),
  })
  return contractAddresses(query, {
    contractService: fixed("contractService", contractService),
    wallet: fixed("wallet", { node }),
  })(true)
}

describe("contract addresses", () => {
  it.each(["l2", "node"] as const)("reads again after a failed %s read", async (failing) => {
    const entry = world(failing)
    await expect(entry.read()).rejects.toThrow()
    const groups = await entry.read()
    const group = failing === "l2" ? groups[0] : groups[2]
    expect(group.rows[0].value).toBe(ADDRESS)
  })
})
