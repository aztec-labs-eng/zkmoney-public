import { beforeEach, describe, expect, it, vi } from "vitest"
import { AccountServiceError, type AccountServiceClient } from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  witness: vi.fn(),
  redeem: vi.fn(),
}))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  buildGoldenTicketWitness: h.witness,
  decodePaylinkInline: () => ({}),
  ContractService: { getInstance: () => ({}) },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  deriveBootstrapKey: () => ({ address: `0x${"11".repeat(20)}` }),
}))
vi.mock("../src/features/paylink/goldenTicketProver", () => ({
  proveGoldenTicketInBrowser: async () => ({ proof: new Uint8Array([1, 2]) }),
}))

const { redeemGoldenTicketForLink } = await import("../src/features/onboarding/goldenTicket")

const DAI = 10n ** 18n
const offer = {
  goldenTicket: { threshold: (2n * DAI).toString(), schedule: { fee: "1", minDeposit: "0" } },
}
const service = (info: object) =>
  ({
    domainInfo: async () => info,
    redeemGoldenTicket: h.redeem,
  } as unknown as AccountServiceClient)
const redeem = (info: object = offer) =>
  redeemGoldenTicketForLink({
    wallet: {} as never,
    accountService: service(info),
    secretKey: {} as never,
    fragment: "frag",
  })

describe("redeemGoldenTicketForLink", () => {
  beforeEach(() => {
    h.witness.mockReset()
    h.redeem.mockReset()
    h.witness.mockResolvedValue({
      amount: 3n * DAI,
      inputs: {},
      publicInputs: { root: { toString: () => "0x1" }, blockNumber: 5 },
      nullifier: { toString: () => "0x2" },
    })
  })

  it("reads no offer as unavailable before any proof", async () => {
    await expect(redeem({ goldenTicket: null })).resolves.toEqual({ status: "unavailable" })
    expect(h.witness).not.toHaveBeenCalled()
  })

  it("reads a redeem the service paused meanwhile as unavailable, keeping the amount", async () => {
    h.redeem.mockRejectedValueOnce(new AccountServiceError(503, "ticket_paused"))
    await expect(redeem()).resolves.toEqual({ status: "unavailable", amount: 3n * DAI })
  })

  it("surfaces every other refusal and returns the service's status otherwise", async () => {
    h.redeem.mockRejectedValueOnce(new AccountServiceError(400, "ticket_invalid"))
    await expect(redeem()).rejects.toThrow("ticket_invalid")
    h.redeem.mockRejectedValueOnce(new AccountServiceError(503, "golden ticket store unavailable"))
    await expect(redeem()).rejects.toThrow("store unavailable")
    h.redeem.mockResolvedValueOnce({ status: "created" })
    await expect(redeem()).resolves.toEqual({ status: "created", amount: 3n * DAI })
  })
})
