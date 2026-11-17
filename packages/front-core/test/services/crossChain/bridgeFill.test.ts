// @vitest-environment node
/** A funding receipt read by every bridge the wallet knows, each in turn. */
import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { bridgeFillIn } from "../../../src/core/services/crossChain/bridgeFill"
import type { BridgeFill } from "../../../src/core/services/crossChain/types"

const PAID = `0x${"b2".repeat(20)}` as Address
const fill = (depositId: string) => ({ provider: "across", depositId } as BridgeFill)

describe("bridgeFillIn", () => {
  it("takes the first bridge that finds a fill, and asks no later one", () => {
    const later = vi.fn(() => fill("2"))
    expect(bridgeFillIn([() => undefined, () => fill("1"), later], [], PAID)).toEqual(fill("1"))
    expect(later).not.toHaveBeenCalled()
  })

  it("finds none when no bridge does", () => {
    expect(bridgeFillIn([() => undefined], [], PAID)).toBeUndefined()
  })
})
