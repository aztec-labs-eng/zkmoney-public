// @vitest-environment node
/** The shown, unfunded deposit addresses whose broadcast still has to land. */
import { describe, expect, it } from "vitest"
import type { BroadcastJob } from "@obsidion/front-core"
import {
  AddressesPublishingError,
  addressesPublishing,
} from "../../../src/features/deposit/addressesPublishing"

const job = (patch: Partial<BroadcastJob> = {}): BroadcastJob => ({
  address: `0x${"11".repeat(20)}`,
  kind: "deposit",
  source: { type: "slot" },
  state: "queued",
  createdAt: 1,
  failures: 0,
  ...patch,
})

describe("addressesPublishing", () => {
  it("counts a shown deposit address whose broadcast has not landed", () => {
    expect(addressesPublishing([job(), job({ state: "proving" }), job({ state: "sent" })])).toBe(3)
  })

  it("leaves out a landed, funded, pooled or rotated broadcast", () => {
    expect(
      addressesPublishing([
        job({ state: "landed" }),
        job({ fundedAt: 5 }),
        job({ kind: "pool" }),
        job({ source: { type: "rotation", owner: "0x01" } }),
      ]),
    ).toBe(0)
  })

  it("leaves out a broadcast that failed more than once, so it cannot hold the sheet", () => {
    expect(addressesPublishing([job({ failures: 1 }), job({ failures: 2 })])).toBe(1)
  })
})

describe("AddressesPublishingError", () => {
  it("is a named error", () => {
    const error = new AddressesPublishingError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("AddressesPublishingError")
  })
})
