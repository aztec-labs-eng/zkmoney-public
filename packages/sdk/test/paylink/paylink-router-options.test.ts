/**
 * How PaylinkService's routers pass options down.
 *
 * - `claimPaylink` dispatches to the per-flavor leaf and forwards `operationId`
 *   and `kind` into the leaf's options arg.
 * - `refundPaylink` lands `operationId` and `kind: "paylink-refund"` on the
 *   merged `sendOptions`, and omits both when the caller passes neither.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import { TxHash } from "@aztec/stdlib/tx"
import { PaylinkService } from "../../src/services/PaylinkService.js"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"

// Stub the claim/refund submit helper so the refund tests reach `sendAndWait`
// without driving real fee resolution / TEE prep.
vi.mock("../../src/services/paylink/paylinkClaimSubmit.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/services/paylink/paylinkClaimSubmit.js")
  >()
  return {
    ...actual,
    preparePaylinkClaimSubmit: vi.fn(async () => ({
      initFn: async () => ({ interaction: {}, sendOpts: {} }),
      buildResult: (x: unknown) => x,
      sendOptions: {},
    })),
  }
})

// Stub paylink key derivation — these tests only care that
// `reconstructPaylinkContract` runs, not real crypto.
vi.mock("../../src/services/paylink/paylinkKeys.js", async (importOriginal) => {
  const { Fr } = await import("@aztec/aztec.js/fields")
  const actual = await importOriginal<typeof import("../../src/services/paylink/paylinkKeys.js")>()
  return {
    ...actual,
    derivePaylinkKeys: vi.fn(async () => ({
      publicKeys: {} as any,
      secretKey: Fr.fromString("0x1"),
      fallbackKeyHash: {} as any,
    })),
  }
})

function makeStubWallet(): any {
  return {
    getDefaultSendOptions: vi.fn(async () => ({})),
  }
}

function makeStubSender(): any {
  const addr = AztecAddress.fromBigIntUnsafe(11n)
  return {
    getAddress: () => addr,
  }
}

function makeStubContractInstance(): any {
  return {
    address: AztecAddress.fromBigIntUnsafe(33n),
    methods: {
      claim: () => ({}),
      refund: () => ({}),
    },
  }
}

function makeService(): {
  service: PaylinkService
  reconstructSpy: ReturnType<typeof vi.fn>
  prepareSpy: ReturnType<typeof vi.fn>
  contractInstance: any
} {
  const wallet = makeStubWallet()
  const sender = makeStubSender()
  // tokenService stub: claimPaylink and refundPaylink both reach through
  // `this.tokenService` for the TEE signer + token contract. These tests stub
  // `sendAndWait` / `getClaimService`, so those accessors are only exercised on
  // the dispatch-through paths — undefined returns are tolerated because
  // nothing downstream uses them in these spy-based tests.
  const tokenService: any = {
    teeSigner: () => undefined,
    getTokenContract: async () => undefined,
  }
  const contractService: any = {}
  // PaylinkService.{claimPaylink,refundPaylink,createPaylinkContract} reach
  // for `this.getTeeSigner()` to build the `ClaimSubmitContext`. These tests
  // don't drive a real TEE batch (spied `sendAndWait` short-circuits before
  // initFn runs), so a present-but-undefined stub is sufficient — the
  // constructor's 7th arg wires it through ServiceBase.
  const teeSignerStub: any = {}
  const service = new PaylinkService(
    wallet,
    sender,
    tokenService,
    contractService,
    undefined,
    teeSignerStub,
  )
  const contractInstance = makeStubContractInstance()
  // `reconstructPaylinkContract` returns `{ contract, instance }` so the router
  // can derive the spend-metadata resolver from the instance. Mirror that shape;
  // instance fields aren't consumed by these tests but the destructure in the
  // production code requires the property to exist.
  const reconstructSpy = vi.fn(async () => ({
    contract: contractInstance,
    instance: {} as any,
    keys: { secretKey: Fr.fromString("0x1"), publicKeys: {} } as any,
    depositTxHash: new TxHash(Fr.fromString("0x3")),
  }))
  ;(service as any).reconstructPaylinkContract = reconstructSpy
  const prepareSpy = vi.fn(async (_t: unknown, _p: unknown) => ({}))
  ;(service as any).prepareClaimInputs = prepareSpy
  return { service, reconstructSpy, prepareSpy, contractInstance }
}

const sampleClaimParams = {
  secret: Fr.fromString("0x1"),
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  classId: Fr.fromString("0x2"),
  chainId: 31337,
  fallbackKeyHash: Fr.fromString("0x5"),
  rollupVersion: 1,
}

describe("PaylinkService.claimPaylink — option spread", () => {
  let getClaimServiceSpy: any
  let leafClaimPayment: any

  beforeEach(() => {
    leafClaimPayment = vi.fn(async () => ({
      txPromise: Promise.resolve({ txHash: "0xstub", receipt: {} }),
      txHash: Promise.resolve("0xstub"),
    }))
    getClaimServiceSpy = { claimPayment: leafClaimPayment }
  })

  it("dispatches to the leaf when the caller passes no options", async () => {
    const { service } = makeService()
    ;(service as any).getClaimService = vi.fn(() => getClaimServiceSpy)

    await service.claimPaylink(DEFAULT_CONTRACTS.paylinkDirect, sampleClaimParams, {} as any)
    expect(leafClaimPayment).toHaveBeenCalledTimes(1)
  })

  it("forwards operationId + kind into the leaf's options arg", async () => {
    const { service } = makeService()
    ;(service as any).getClaimService = vi.fn(() => getClaimServiceSpy)

    await service.claimPaylink(DEFAULT_CONTRACTS.paylinkDirect, sampleClaimParams, {} as any, {
      operationId: "op-router-1",
      kind: "paylink-claim",
    })
    expect(leafClaimPayment).toHaveBeenCalledTimes(1)
    // 5-arg signature post-U5: (contractInstance, proof, recipient,
    // submitContext, options?). operationId / kind live on `options` at
    // index 4.
    const leafOpts = leafClaimPayment.mock.calls[0][4]
    expect(leafOpts.operationId).toBe("op-router-1")
    expect(leafOpts.kind).toBe("paylink-claim")
  })
})

describe("PaylinkService.refundPaylink — option spread", () => {
  // Spy on `sendAndWait` to capture the merged sendOptions without driving
  // the real interaction.send / wallet pipeline.
  function spySendAndWait(service: any): Array<any> {
    const calls: Array<any> = []
    service.sendAndWait = vi.fn((_initFn: any, _buildResult: any, opts: any) => {
      calls.push(opts)
      return {
        txPromise: Promise.resolve({ txHash: "0xstub" }),
        txHash: Promise.resolve("0xstub"),
      }
    })
    return calls
  }

  const refundArgs = () => [sampleClaimParams] as const

  it("forwards operationId + kind: 'paylink-refund' onto the sendAndWait opts when caller passes them", async () => {
    const { service } = makeService()
    const sendCalls = spySendAndWait(service)

    await service.refundPaylink(...refundArgs(), {
      operationId: "op-refund-1",
      kind: "paylink-refund",
    })

    // U5: `operationId` / `kind` live as siblings of `sendOptions` on the
    // `sendAndWait` opts (not nested inside `sendOptions`). `sendAndWait`
    // itself merges them into the wallet-bound `sendOptions` before
    // `.send()`. The previous shape duplicated them into both locations;
    // the spy now asserts on the outer-arg position.
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].operationId).toBe("op-refund-1")
    expect(sendCalls[0].kind).toBe("paylink-refund")
  })

  it("omits operationId / kind when caller does not pass them (back-compat)", async () => {
    const { service } = makeService()
    const sendCalls = spySendAndWait(service)

    await service.refundPaylink(...refundArgs())

    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].operationId).toBeUndefined()
    expect(sendCalls[0].kind).toBeUndefined()
  })
})


