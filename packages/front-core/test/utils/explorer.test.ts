import { describe, expect, it } from "vitest"
import { Network } from "@obsidion/core/constants"
import { l2ExplorerTxEffectsBase } from "../../src/utils/explorer"

describe("l2ExplorerTxEffectsBase", () => {
  it("uses a retired major's explorers", () => {
    expect(l2ExplorerTxEffectsBase(Network.MAINNET, "http://localhost:8080", "5")).toBe(
      "https://v5.aztecscan.xyz/tx-effects/",
    )
    expect(l2ExplorerTxEffectsBase(Network.TESTNET, "http://localhost:8080", "5")).toBe(
      "https://v5.testnet.aztecscan.xyz/tx-effects/",
    )
  })

  it("ignores a major that is not a number, so a node cannot change the host", () => {
    expect(l2ExplorerTxEffectsBase(Network.MAINNET, "", "5@attacker.example/")).toBe(
      "https://aztecscan.xyz/tx-effects/",
    )
  })
})
