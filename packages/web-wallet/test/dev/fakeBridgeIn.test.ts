import { describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { FakeBridgeIn } from "../../src/dev/fakeBridgeIn"

const TX = `0x${"ab".repeat(32)}` as Hex
const FILL = `0x${"cd".repeat(32)}` as Hex

describe("FakeBridgeIn", () => {
  it("fills a bridge-in once, through the caller", async () => {
    const fill = vi.fn(async () => FILL)
    const fake = new FakeBridgeIn(fill, () => 0)
    expect(await fake.status(84532, TX)).toEqual({ status: "filled", fillTxHash: FILL })
    expect(await fake.status(84532, TX)).toEqual({ status: "filled", fillTxHash: FILL })
    expect(fill).toHaveBeenCalledTimes(1)
  })
})
