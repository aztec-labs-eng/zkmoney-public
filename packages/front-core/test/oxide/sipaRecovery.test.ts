import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  deriveRecoveryAddress: vi.fn(),
  deriveRecoveryPrivateKey: vi.fn(),
  buildRecoverErc20Digest: vi.fn(),
  signSipaRecovery: vi.fn(),
  buildSipaRecoverCall: vi.fn(),
}))

vi.mock("../../src/core/services/deposits/sipa/recoverySignature", () => ({
  buildRecoverErc20Digest: mocks.buildRecoverErc20Digest,
  signSipaRecovery: mocks.signSipaRecovery,
}))
vi.mock("../../src/core/services/deposits/sipa/stealth", () => ({
  deriveRecoveryAddress: mocks.deriveRecoveryAddress,
  deriveRecoveryPrivateKey: mocks.deriveRecoveryPrivateKey,
}))
vi.mock("@obsidion/sdk", () => ({
  buildSipaRecoverCall: mocks.buildSipaRecoverCall,
}))
vi.mock("@aztec/aztec.js/fields", () => ({
  Fr: { fromHexString: (value: string) => ({ toString: () => value }) },
}))
vi.mock("@aztec/foundation/eth-address", () => ({
  EthAddress: { fromString: (value: string) => ({ toString: () => value.toLowerCase() }) },
}))

import { runSipaRecovery } from "../../src/oxide/sipaRecovery"

const SIPA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const RECOVERY = "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a"
const TARGET = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b"
const TOKEN = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b"
const HASH = `0x${"ab".repeat(32)}`

function makeDeps(overrides: Record<string, unknown> = {}) {
  const store = { get: vi.fn(() => null), upsert: vi.fn(async () => undefined) }
  const deps = {
    record: {
      sipaAddress: SIPA,
      phase: "recoverable",
      messageSecret: `0x${"11".repeat(32)}`,
      recoveryAddress: RECOVERY,
      tokenAddress: undefined,
    },
    stealthKey: { scalar: 0x5eedn, publicKey: { x: 1n, y: 2n } },
    target: TARGET,
    tokens: [TOKEN],
    chainId: 11155111,
    deployment: {
      readDeployed: vi.fn(async () => true),
      candidates: [],
      predict: vi.fn(async () => "0x0000000000000000000000000000000000000000"),
    },
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
    store,
    makeNonce: () => new Uint8Array(32).fill(7),
    ...overrides,
  }
  return { deps: deps as never, store, send: deps.sendTransaction as ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.deriveRecoveryAddress.mockReturnValue({ toString: () => RECOVERY })
  mocks.deriveRecoveryPrivateKey.mockReturnValue(0xfeedn)
  mocks.buildRecoverErc20Digest.mockReturnValue(Buffer.alloc(32, 1))
  mocks.signSipaRecovery.mockReturnValue(`0x${"cd".repeat(65)}`)
  mocks.buildSipaRecoverCall.mockReturnValue({ to: SIPA, data: "0xdeadbeef" })
})

describe("runSipaRecovery", () => {
  it("derives, signs, submits, waits, and flips the record to recovered", async () => {
    const { deps, store, send } = makeDeps()
    const hash = await runSipaRecovery(deps)

    expect(hash).toBe(HASH)
    expect(mocks.deriveRecoveryPrivateKey).toHaveBeenCalledWith(
      0x5eedn,
      expect.objectContaining({ toString: expect.any(Function) }),
    )
    expect(mocks.signSipaRecovery).toHaveBeenCalledWith(expect.any(Buffer), 0xfeedn)
    expect(mocks.buildSipaRecoverCall).toHaveBeenCalledWith(
      expect.objectContaining({
        deployed: true,
        recoveries: [
          expect.objectContaining({
            sipa: SIPA,
            target: TARGET,
            token: TOKEN,
            nonce: `0x${"07".repeat(32)}`,
          }),
        ],
      }),
    )
    expect(send).toHaveBeenCalledWith(SIPA, "0xdeadbeef")
    expect(store.upsert).toHaveBeenLastCalledWith(SIPA, {
      phase: "recovered",
      recoveryTxHash: HASH,
      tokenAddress: TOKEN,
    })
  })

  it("names the token it moved on the recovered record, with the display the caller pinned", async () => {
    const recordToken = "0x1111111111111111111111111111111111111111"
    const { deps, store } = makeDeps({
      record: {
        sipaAddress: SIPA,
        phase: "recoverable",
        messageSecret: `0x${"11".repeat(32)}`,
        recoveryAddress: RECOVERY,
        tokenAddress: recordToken,
        tokenSymbol: "DAI",
        tokenDecimals: 18,
      },
      tokens: [recordToken],
    })
    await runSipaRecovery(deps)
    expect(store.upsert).toHaveBeenLastCalledWith(SIPA, {
      phase: "recovered",
      recoveryTxHash: HASH,
      tokenAddress: recordToken,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
    })
  })

  it("stamps the submitted hash on the record before waiting for its receipt", async () => {
    const { deps, store } = makeDeps({
      waitForReceipt: vi.fn(() => new Promise<boolean>(() => {})),
    })
    const pending = runSipaRecovery(deps)
    await vi.waitFor(() => expect(store.upsert).toHaveBeenCalled())
    expect(store.upsert).toHaveBeenCalledWith(SIPA, {
      phase: "recoverable",
      recoveryTxHash: HASH,
    })
    expect(store.upsert).toHaveBeenCalledTimes(1)
    void pending
  })

  it("stamps the hash on the record's live phase, not the one captured before signing", async () => {
    const { deps, store } = makeDeps({
      waitForReceipt: vi.fn(() => new Promise<boolean>(() => {})),
    })
    store.get.mockReturnValue({ phase: "claimed" } as never)
    const pending = runSipaRecovery(deps)
    await vi.waitFor(() => expect(store.upsert).toHaveBeenCalled())
    expect(store.upsert).toHaveBeenCalledWith(SIPA, { phase: "claimed", recoveryTxHash: HASH })
    void pending
  })

  it("fails closed before signing when the derived recovery address mismatches", async () => {
    mocks.deriveRecoveryAddress.mockReturnValue({
      toString: () => "0x9999999999999999999999999999999999999999",
    })
    const { deps, store, send } = makeDeps()
    await expect(runSipaRecovery(deps)).rejects.toThrow(/does not match/)
    expect(send).not.toHaveBeenCalled()
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it("does not mark recovered when the transaction reverts", async () => {
    const { deps, store } = makeDeps({ waitForReceipt: vi.fn(async () => false) })
    await expect(runSipaRecovery(deps)).rejects.toThrow(/reverted/)
    expect(store.upsert).not.toHaveBeenCalledWith(
      SIPA,
      expect.objectContaining({ phase: "recovered" }),
    )
  })

  it("signs each token with its own nonce and recovers them in one transaction", async () => {
    const other = "0x1111111111111111111111111111111111111111"
    let n = 0
    const { deps, store, send } = makeDeps({
      tokens: [TOKEN, other],
      makeNonce: () => new Uint8Array(32).fill(++n),
    })
    await runSipaRecovery(deps)
    expect(mocks.signSipaRecovery).toHaveBeenCalledTimes(2)
    expect(mocks.buildSipaRecoverCall).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveries: [
          expect.objectContaining({ token: TOKEN, nonce: `0x${"01".repeat(32)}` }),
          expect.objectContaining({ token: other, nonce: `0x${"02".repeat(32)}` }),
        ],
      }),
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.upsert).toHaveBeenLastCalledWith(
      SIPA,
      expect.objectContaining({ tokenAddress: TOKEN }),
    )
  })

  it("submits nothing when a later token's signature fails", async () => {
    mocks.signSipaRecovery
      .mockReturnValueOnce(`0x${"cd".repeat(65)}`)
      .mockImplementationOnce(() => {
        throw new Error("signature refused")
      })
    const { deps, store, send } = makeDeps({ tokens: [TOKEN, SIPA] })
    await expect(runSipaRecovery(deps)).rejects.toThrow(/signature refused/)
    expect(send).not.toHaveBeenCalled()
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it("fails closed on an undeployed SIPA no candidate predicts, without submitting", async () => {
    const { deps, store, send } = makeDeps({
      deployment: {
        readDeployed: vi.fn(async () => false),
        candidates: [{ sipaFactory: TARGET, args: { resweepable: true } }],
        predict: vi.fn(async () => "0x9999999999999999999999999999999999999999"),
      },
    })
    await expect(runSipaRecovery(deps)).rejects.toThrow(/has not been deployed/)
    expect(send).not.toHaveBeenCalled()
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it("deploy-and-recovers an undeployed SIPA through the predicted candidate", async () => {
    const candidate = { protocol: "legacy-eoa", sipaFactory: TARGET, args: { resweepable: false } }
    const decoy = { protocol: "legacy-eoa", sipaFactory: TARGET, args: { resweepable: true } }
    const predict = vi.fn(async (c: { args: { resweepable: boolean } }) =>
      c.args.resweepable ? "0x9999999999999999999999999999999999999999" : SIPA,
    )
    const { deps } = makeDeps({
      deployment: {
        readDeployed: vi.fn(async () => false),
        candidates: [decoy, candidate],
        predict,
      },
    })
    await runSipaRecovery(deps)
    expect(mocks.buildSipaRecoverCall).toHaveBeenCalledWith(
      expect.objectContaining({
        deployed: false,
        deployment: candidate,
      }),
    )
  })
})
