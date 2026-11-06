// @vitest-environment node
/**
 * Whether a link's creator can take it back now, once it expires, or not at all: read from the
 * chain, as the refund itself decides.
 */
import type { PaylinkTransaction } from "@obsidion/front-core"
import { describe, expect, it, vi } from "vitest"

/** The block that spent the escrow, if any, and the newest block an L1 checkpoint holds. */
const h = vi.hoisted(() => ({
  spentAt: undefined as number | undefined,
  checkpointed: 10,
  chainNow: 0,
}))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  decodePaylinkInline: (fragment: string) => ({ fragment }),
  PaylinkService: class {
    async paylinkClaimBlock() {
      return h.spentAt
    }
  },
}))
vi.mock("../../../src/features/paylink/chainTime", () => ({
  latestChainSeconds: async () => h.chainNow,
}))

const { linkRefundable } = await import("../../../src/features/paylink/sponsoredPaylink")

const deps = {
  wallet: {
    node: { getBlockNumber: async (tag: string) => (tag === "checkpointed" ? h.checkpointed : 0) },
  },
  contractService: {},
} as never
/** Cancellable until 1500, claimable until 2000. */
const row = { refundableUntil: 1500, untilClaimable: 2000 } as PaylinkTransaction

const at = (chainNow: number, link: PaylinkTransaction | null = row, spentAt?: number) => {
  Object.assign(h, { chainNow, spentAt })
  return linkRefundable(deps, link, "frag")
}

describe("linkRefundable", () => {
  it("is spent once a checkpoint holds the escrow's spend, whatever the time", async () => {
    expect(await at(500, row, 10)).toBe("spent")
    expect(await at(2500, row, 9)).toBe("spent")
  })

  it("is spending while the spend's block is past the checkpointed one, which a reorg can undo", async () => {
    expect(await at(500, row, 11)).toBe("spending")
    expect(await at(2500, row, 11)).toBe("spending")
  })

  it("is now inside the cancel window, and later once a cancel could no longer land", async () => {
    expect(await at(500)).toBe("now")
    // Within the cancel margin of the window's close.
    expect(await at(1480)).toBe("later")
    expect(await at(2000)).toBe("later")
  })

  it("is now again once the link expires, for the reclaim", async () => {
    expect(await at(2001)).toBe("now")
  })

  it("waits for a row that records no window", async () => {
    expect(await at(500, null)).toBe("later")
    expect(await at(500, { untilClaimable: 2000 } as PaylinkTransaction)).toBe("later")
  })
})
