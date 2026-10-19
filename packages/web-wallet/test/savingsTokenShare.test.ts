import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  TokenService: { create: h.create },
}))
vi.mock("../src/config/oxideTuple", () => ({
  getAssetTuple: async () => ({ portal: `0x${"bb".repeat(20)}`, l2Token: `0x${"2b".repeat(32)}` }),
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ assets: [] }) }))
import type { ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import { savingsRescanToken } from "../src/features/savings/savingsGateway"

const account = (address: string) =>
  ({ getAddress: () => ({ toString: () => address }) }) as unknown as ObsidionAccount

describe("the Savings token service", () => {
  it("is created once per wallet and account, and again after a failed create", async () => {
    const wallet = {} as ObsidionWallet
    const service = { id: "susds" }
    h.create.mockRejectedValueOnce(new Error("node down")).mockResolvedValue(service)

    await expect(savingsRescanToken(wallet, account("0xa"))).rejects.toThrow("node down")
    const first = await savingsRescanToken(wallet, account("0xa"))
    const second = await savingsRescanToken(wallet, account("0xa"))
    expect(first?.tokenService).toBe(service)
    expect(second?.tokenService).toBe(service)
    expect(h.create).toHaveBeenCalledTimes(2)

    await savingsRescanToken(wallet, account("0xb"))
    await savingsRescanToken({} as ObsidionWallet, account("0xa"))
    expect(h.create).toHaveBeenCalledTimes(4)
  })
})
