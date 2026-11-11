import { describe, expect, it } from "vitest"
import type { BridgeInRecord } from "@obsidion/front-core"
import { bridgeInPaid, bridgeInPhase } from "../../../src/features/deposit/bridgeInView"

const pays = { payee: "bob", requestId: "r" }

describe("a bridge-in's status", () => {
  it.each([
    [{ status: "signing" }, false, "bridging", false],
    [{ status: "pending", pays }, false, "bridging", false],
    [{ status: "filled" }, false, "arriving", false],
    [{ status: "filled" }, true, "arrived", false],
    // A payment lands at the payee's address: nothing here waits on this wallet's deposits.
    [{ status: "filled", pays }, false, "arriving", true],
    [{ status: "filled", pays }, true, "arriving", true],
    [{ status: "expired", pays }, false, "failed", false],
    [{ status: "failed" }, false, "failed", false],
  ] as const)("%o, landed %s: %s", (record, landed, phase, paid) => {
    const status = record as Pick<BridgeInRecord, "status" | "pays">
    expect(bridgeInPhase(status, landed)).toBe(phase)
    expect(bridgeInPaid(status)).toBe(paid)
  })
})
