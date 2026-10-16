import { beforeEach, describe, expect, it, vi } from "vitest"

const MANIFEST = "http://manifest.test/staging.json"
const DAI_PORTAL = "0x00000000000000000000000000000000000000aa"
const SKY_PORTAL = "0x00000000000000000000000000000000000000bb"
const state = vi.hoisted(() => ({ listed: undefined as Promise<unknown> | undefined }))
vi.mock("../src/config/oxideTuple", () => ({ getAssetTuple: () => state.listed }))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ assets: [], oxideProfile: { manifestUrl: MANIFEST, portal: DAI_PORTAL } }),
}))
import { getConfig } from "../src/config/env"
import { getSavingsTuple, moveSummary } from "../src/features/savings/savingsGateway"

beforeEach(() => {
  state.listed = undefined
})

describe("getSavingsTuple", () => {
  it("is the profile's sUSDS asset, and nothing where the profile lists none", async () => {
    state.listed = Promise.resolve({ portal: SKY_PORTAL, version: "v12-sky" })
    await expect(getSavingsTuple(getConfig())).resolves.toEqual({
      portal: SKY_PORTAL,
      version: "v12-sky",
    })
    state.listed = undefined
    await expect(getSavingsTuple(getConfig())).resolves.toBeUndefined()
  })
})

describe("moveSummary", () => {
  const ONE = 10n ** 18n
  it("names a move by its dollar value and route, pricing a move out's shares at the vault", () => {
    expect(moveSummary("in", 25n * ONE)).toBe("$25.00 to Savings")
    expect(moveSummary("in", 25n * ONE + 5n * 10n ** 17n)).toBe("$25.50 to Savings")
    // A move out of 255.178858708317111766 shares at a 1.07 share price is $273.04, not the share count.
    const price = (107n * ONE) / 100n
    expect(moveSummary("out", 255_178858708317111766n, price)).toBe("$273.04 to Main Account")
    // MAX out burns every share: the summary is the position's value.
    const shares = 700n * ONE
    expect(moveSummary("out", shares, 714287899390558444472n / 700n)).toBe(
      "$714.28 to Main Account",
    )
    expect(moveSummary("out", shares)).toBe("Savings to Main Account")
  })
})
