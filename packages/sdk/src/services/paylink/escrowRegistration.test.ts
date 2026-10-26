import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"

const { registerPaylinkContractWithKeys, registerEscrowTagSecret, findEscrowDepositTx, instance } =
  vi.hoisted(() => ({
    registerPaylinkContractWithKeys: vi.fn(async () => undefined),
    registerEscrowTagSecret: vi.fn(async () => undefined),
    findEscrowDepositTx: vi.fn(),
    instance: { address: { toString: () => "0xescrow" }, initializationHash: {} },
  }))
vi.mock("./paylinkEscrow.js", () => ({
  linkEscrow: async () => ({ artifact: {}, keys: {}, instance }),
}))
vi.mock("./paylinkInlineCodec.js", () => ({ assertLinkChain: () => undefined }))
vi.mock("../claimSponsor.js", () => ({ linkChainInfo: async () => ({}) }))
vi.mock("./paylinkKeys.js", () => ({ registerPaylinkContractWithKeys, registerEscrowTagSecret }))
vi.mock("./paylinkRecovery.js", () => ({ findEscrowDepositTx }))

const { escrowDepositTx, registerEscrow, sharedNoteRead } = await import("./escrowRegistration.js")

const params = (secret: bigint) =>
  ({
    paylinkType: "paylinkDirect",
    classId: new Fr(1n),
    secret: new Fr(secret),
    fallbackKeyHash: new Fr(2n),
    chainId: 31337,
    rollupVersion: 1,
    escrowTagSecret: "point",
  } as never)

const deps = () =>
  ({
    wallet: { registerSender: vi.fn(async () => undefined), node: {} },
    contractService: {},
  } as never)

beforeEach(() => vi.clearAllMocks())

describe("registerEscrow", () => {
  it("registers a link once per wallet, however many reads ask at once", async () => {
    const wallet = deps()
    await Promise.all([registerEscrow(wallet, params(7n)), registerEscrow(wallet, params(7n))])
    await registerEscrow(wallet, params(7n))
    expect(registerPaylinkContractWithKeys).toHaveBeenCalledOnce()
    expect(registerEscrowTagSecret).toHaveBeenCalledOnce()

    // Another link, or another wallet, registers its own.
    await registerEscrow(wallet, params(8n))
    await registerEscrow(deps(), params(7n))
    expect(registerPaylinkContractWithKeys).toHaveBeenCalledTimes(3)
  })

  it("tries a failed registration again", async () => {
    const wallet = deps()
    registerPaylinkContractWithKeys.mockRejectedValueOnce(new Error("pxe busy"))
    await expect(registerEscrow(wallet, params(9n))).rejects.toThrow("pxe busy")
    await expect(registerEscrow(wallet, params(9n))).resolves.toMatchObject({ instance })
    expect(registerPaylinkContractWithKeys).toHaveBeenCalledTimes(2)
  })
})

describe("escrowDepositTx", () => {
  it("remembers the funding tx once found, and asks again while there is none", async () => {
    const wallet = { node: {} } as never
    findEscrowDepositTx.mockResolvedValueOnce(undefined)
    expect(await escrowDepositTx(wallet, instance as never)).toBeUndefined()
    findEscrowDepositTx.mockResolvedValueOnce({ txHash: "0xdeposit", l2BlockNumber: 3 })
    expect(await escrowDepositTx(wallet, instance as never)).toMatchObject({ txHash: "0xdeposit" })
    expect(await escrowDepositTx(wallet, instance as never)).toMatchObject({ txHash: "0xdeposit" })
    expect(findEscrowDepositTx).toHaveBeenCalledTimes(2)
  })
})

describe("sharedNoteRead", () => {
  it("runs one simulation for overlapping reads of an escrow, and a fresh one after", async () => {
    const wallet = {}
    let settle: (v: unknown) => void = () => {}
    const read = vi.fn(() => new Promise<never>((r) => (settle = r as never)))
    const first = sharedNoteRead(wallet, "0xescrow", read)
    const second = sharedNoteRead(wallet, "0xescrow", read)
    settle({ amount: 1n })
    await expect(Promise.all([first, second])).resolves.toEqual([{ amount: 1n }, { amount: 1n }])
    expect(read).toHaveBeenCalledOnce()
    void sharedNoteRead(wallet, "0xescrow", read)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
