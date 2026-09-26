/**
 * Call-site wiring guard for `PaylinkService.createPaylinkContract`.
 *
 * `serviceBase-silent.test.ts` proves `sendAndWait` behaves correctly WHEN
 * `silent: true` is supplied. This test pins the other half: that
 * `createPaylinkContract` actually SUPPLIES `{ silent: true, kind:
 * "paylink-create" }` (plus the sender `from` and the paylink-instance
 * `additionalScopes`) when it dispatches. The live PXE round-trip tests
 * (direct/happy-path, alpha_paylink_deposit) return ciphertext/txHash and
 * claim/refund regardless of these options — so a future edit dropping
 * `silent: true` would reintroduce the tracked-tx status row / proving-UI
 * reset this refactor removed WITHOUT any existing test going red. This test
 * closes that gap by spying `sendAndWait` and asserting the options it's
 * handed.
 *
 * The whole `createPaylinkContract` prelude (artifact load, authwit, the
 * real `prepareDepositSubmit` sim + TEE sign) is stubbed out — only the
 * dispatch wiring is under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildTransferMetaForSend } from "../../src/services/transferMeta.js"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import { PRIVATE_LOG_CIPHERTEXT_LEN } from "@aztec/constants"

const { depositSpy } = vi.hoisted(() => ({
  depositSpy: vi.fn(() => ({ __fake: "depositInteraction" })),
}))

// Stub `prepareDepositSubmit` so the dispatch test never runs buildTeeOperation
// / simulation / TEE signing — it just hands back a fake { batchCall, sendOpts }.
vi.mock("../../src/services/paylink/paylinkDepositSubmit.js", () => ({
  prepareDepositSubmit: vi.fn(async () => ({
    batchCall: { __fake: "batchCall" },
    sendOpts: { additionalScopes: [], fee: {} },
  })),
}))

// Stub `Contract.at` so we don't need a real artifact ABI to build the deposit
// interaction; preserve all other exports.
vi.mock("@aztec/aztec.js/contracts", async (importActual) => {
  const actual = await importActual<typeof import("@aztec/aztec.js/contracts")>()
  return {
    ...actual,
    Contract: {
      ...(actual.Contract as object),
      at: vi.fn(() => ({
        methods: {
          deposit: depositSpy,
        },
      })),
    },
  }
})

// Stub paylink key derivation/registration — part of the create prelude, not
// the dispatch wiring under test. Avoids computePartialAddress on a fake instance.
vi.mock("../../src/services/paylink/paylinkKeys.js", () => ({
  derivePaylinkKeys: vi.fn(async () => ({
    publicKeys: { __fake: "publicKeys" },
    secretKey: "fake-secret",
    fallbackSecret: "fake-fallback-secret",
    fallbackKeyHash: "fake-fbpk-hash",
    nonce: { day: 20_000, n: 0 },
  })),
  registerPaylinkContractWithKeys: vi.fn(async () => undefined),
  computeEscrowTagSecret: vi.fn(async () => "fake-escrow-tag-secret"),
}))

import { PaylinkService } from "../../src/services/PaylinkService.js"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"

const INSTANCE_ADDR = AztecAddress.fromBigIntUnsafe(33n)
const SENDER_ADDR = AztecAddress.fromBigIntUnsafe(11n)
const CLASS_ID = Fr.fromString("0xc1a55")

function makeService() {
  const wallet: any = {
    node: { getNodeInfo: vi.fn(async () => ({ l1ChainId: 31337, rollupVersion: 1 })) },
    registerContract: vi.fn().mockResolvedValue(undefined),
    getDefaultSendOptions: vi.fn(async () => ({})),
  }
  const sender: any = { getAddress: () => SENDER_ADDR }
  const tokenService: any = {
    tokenAddress: AztecAddress.fromBigIntUnsafe(44n), // must equal emailInitParams.token
    constructTransferCallAuthwit: vi.fn().mockResolvedValue({}),
    getTokenContract: vi.fn().mockResolvedValue({ address: AztecAddress.fromBigIntUnsafe(22n) }),
  }
  const teeSignerStub: any = {}
  const service = new PaylinkService(
    wallet,
    sender,
    tokenService,
    {} as any,
    undefined,
    teeSignerStub,
  )

  // Stub the artifact/instance derivation (deploys + secret-key derivation).
  ;(service as any).getContractInstance = vi.fn().mockResolvedValue({
    instance: {
      address: INSTANCE_ADDR,
      initializationHash: Fr.fromString("0x99"),
      currentContractClassId: CLASS_ID,
    },
    secret: Fr.fromString("0x77"),
    artifact: {},
  })

  // Spy `sendAndWait` so the wiring (silent / kind / sendOptions) is captured
  // without dispatching a real tx. `sentTx` resolves with the self-delivery
  // paylink offchain message the extraction logic looks for.
  const sentMessage = {
    contractAddress: INSTANCE_ADDR,
    recipient: INSTANCE_ADDR,
    payload: new Array(PRIVATE_LOG_CIPHERTEXT_LEN + 2).fill(Fr.ZERO),
  }
  const sendAndWaitSpy = vi.spyOn(service as any, "sendAndWait").mockReturnValue({
    txPromise: Promise.resolve({ txHash: "0xabc", receipt: {} }),
    txHash: Promise.resolve("0xabc"),
    sentTx: Promise.resolve({
      txHash: "0xabc",
      offchainMessages: [sentMessage],
      offchainEffects: [],
    }),
  })

  return { service, sendAndWaitSpy, tokenService }
}

const FUNDING_META = buildTransferMetaForSend({
  paylinkCreated: {
    flavor: "email",
    day: 20_000,
    secret: Fr.fromString("0x77"),
    fallbackKeyHash: Fr.fromString("0x89"),
    email: "pay@example.com",
  },
})

const emailInitParams = {
  email: "pay@example.com",
  amount: 1_000_000n,
  hash: Fr.fromString("0x1234"),
  token: AztecAddress.fromBigIntUnsafe(44n),
  window: {
    fromClaimable: 0n,
    untilClaimable: 86_400n,
    refundableUntil: 0n,
  },
  registry_address: AztecAddress.fromBigIntUnsafe(55n),
  vkey_hash: Fr.fromString("0x66"),
  paylinkKeys: {
    publicKeys: { __fake: "publicKeys" },
    secretKey: Fr.fromString("0x77"),
    fallbackSecret: Fr.fromString("0x88"),
    fallbackKeyHash: Fr.fromString("0x89"),
    nonce: { day: 20_000, n: 0 },
  } as any,
}

describe("PaylinkService.createPaylinkContract — dispatch wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("dispatches via sendAndWait with silent:true and kind:paylink-create", async () => {
    const { service, sendAndWaitSpy } = makeService()

    const params = await service.createPaylinkContract(
      emailInitParams,
      DEFAULT_CONTRACTS.paylinkEmail,
      { operationId: "op-123", resolveSpendMetadata: async () => ({} as any) },
    )

    expect(sendAndWaitSpy).toHaveBeenCalledTimes(1)
    const opts = sendAndWaitSpy.mock.calls[0]![2] as any
    expect(opts.silent).toBe(true)
    expect(opts.kind).toBe("paylink-create")
    expect(opts.operationId).toBe("op-123")
    expect(opts.sendOptions.from).toBe(SENDER_ADDR)
    expect(opts.sendOptions.additionalScopes).toEqual([INSTANCE_ADDR])
    // The creator tags the tx (default sender): their own Transfer copy and change note stay
    // discoverable on a fresh device; the claimer gets the escrow's note tag from the link.
    expect(opts.sendOptions.sendMessagesAs).toBeUndefined()
    expect(params.escrowTagSecret).toBe("fake-escrow-tag-secret")

    // Deposit values are private calldata. The paylink instance itself is initializerless, so
    // these values do not influence its deterministic initialization hash/address.
    // Both flavors take the funding account last — refund rights bind to it.
    expect(depositSpy).toHaveBeenCalledWith(
      emailInitParams.amount,
      emailInitParams.registry_address,
      emailInitParams.vkey_hash,
      emailInitParams.hash,
      emailInitParams.window.fromClaimable,
      emailInitParams.window.untilClaimable,
      emailInitParams.window.refundableUntil,
      emailInitParams.token,
      SENDER_ADDR,
      FUNDING_META,
    )

    // txHash is read off the `sentTx` result, not txPromise.
    expect(params.txHash).toBe("0xabc")
    // The link pins the class the escrow was derived against and the chain it was funded on.
    expect(params.classId).toBe(CLASS_ID)
    expect(params.chainId).toBe(31337)
    expect(params.fallbackKeyHash).toBe(emailInitParams.paylinkKeys.fallbackKeyHash)
    expect(params.fallbackSecret).toBe(emailInitParams.paylinkKeys.fallbackSecret)
  })

  it("passes direct-paylink deposit values as private calldata in ABI order", async () => {
    const { service } = makeService()

    await service.createPaylinkContract(emailInitParams, DEFAULT_CONTRACTS.paylinkDirect, {
      resolveSpendMetadata: async () => ({} as any),
    })

    expect(depositSpy).toHaveBeenCalledWith(
      emailInitParams.amount,
      emailInitParams.window.fromClaimable,
      emailInitParams.window.untilClaimable,
      emailInitParams.window.refundableUntil,
      emailInitParams.token,
      SENDER_ADDR,
      buildTransferMetaForSend({
        paylinkCreated: {
          flavor: "direct",
          day: 20_000,
          secret: emailInitParams.paylinkKeys.secretKey,
          fallbackKeyHash: emailInitParams.paylinkKeys.fallbackKeyHash,
          email: emailInitParams.email,
        },
      }),
    )
  })

  it("puts the memo beside the created lane in the deposit meta and hashes the pull authwit over it", async () => {
    const { service, tokenService } = makeService()

    await service.createPaylinkContract(
      { ...emailInitParams, memo: "coffee" },
      DEFAULT_CONTRACTS.paylinkDirect,
      { resolveSpendMetadata: async () => ({} as any) },
    )

    const meta = buildTransferMetaForSend({
      memo: "coffee",
      paylinkCreated: {
        flavor: "direct",
        day: 20_000,
        secret: emailInitParams.paylinkKeys.secretKey,
        fallbackKeyHash: emailInitParams.paylinkKeys.fallbackKeyHash,
        email: emailInitParams.email,
      },
    })
    expect(depositSpy.mock.calls[0]!.at(-1)).toEqual(meta)
    // The escrow forwards the deposit meta into `transfer`; an authwit over any other meta is
    // rejected by the sender's account.
    expect(tokenService.constructTransferCallAuthwit).toHaveBeenCalledWith(
      emailInitParams.amount,
      SENDER_ADDR,
      INSTANCE_ADDR,
      depositSpy.mock.calls[0]!.at(-1),
    )
  })

  it("announces nothing for bring-your-own keys without a nonce", async () => {
    const { service } = makeService()
    const { nonce: _dropped, ...keys } = emailInitParams.paylinkKeys
    await service.createPaylinkContract(
      { ...emailInitParams, paylinkKeys: keys as any },
      DEFAULT_CONTRACTS.paylinkDirect,
      { resolveSpendMetadata: async () => ({} as any) },
    )
    expect(depositSpy.mock.calls[0]!.at(-1)).toEqual(buildTransferMetaForSend({}))
  })
})
