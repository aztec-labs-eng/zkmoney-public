/**
 * Unit tests for the per-flavor paylink claim services.
 *
 * Verifies that each leaf's `claimPayment` merges caller-supplied
 * `operationId` and `kind` into the `sendOptions` object passed to
 * `ServiceBase.sendAndWait` — which is the object spread into
 * `interaction.send(...)` and ultimately reaches `wallet.sendTx`'s opts.
 *
 * Strategy: instantiate each service with a minimal stub wallet/sender,
 * spy on the instance's `sendAndWait` to capture the third arg, and assert
 * the captured `sendOptions` shape.
 *
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import { TxHash } from "@aztec/stdlib/tx"
import { PaylinkDirectClaimService } from "../../src/services/paylink/claimServices/PaylinkDirectClaimService.js"
import { PaylinkEmailClaimService } from "../../src/services/paylink/claimServices/PaylinkEmailClaimService.js"
import type { ClaimSubmitContext } from "../../src/services/paylink/types.js"
import type { TokenService } from "../../src/services/TokenService.js"
import type { TeeSigner } from "@oxide/oxide-lib/types.js"
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract"

// Stub `ClaimSubmitContext` for the spy-based dispatch tests. The leaves call
// `preparePaylinkClaimSubmit(...)` BEFORE `this.sendAndWait(...)`, and the
// helper synchronously reaches into `submitContext.tokenService.getTokenContract()`
// and `submitContext.paylinkInstance.address` (the paylink-flavoured resolver
// closes over the address). Provide just enough shape that those calls don't
// throw — the closures (initFn, resolveSpendMetadata) are never invoked
// because `sendAndWait` is spied.
const TEE_CTX_STUB: ClaimSubmitContext = {
  tokenService: {
    getTokenContract: async () => undefined as any,
  } as unknown as TokenService,
  teeSigner: {} as unknown as TeeSigner,
  paylinkSecret: Fr.fromString("0x0"),
  paylinkInstance: {
    address: AztecAddress.fromBigIntUnsafe(99n),
  } as unknown as ContractInstanceWithAddress,
  depositTxHash: new TxHash(Fr.fromString("0x0")),
}

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

function makeStubRecipient(): any {
  const addr = AztecAddress.fromBigIntUnsafe(22n)
  return {
    getAddress: () => addr,
  }
}

function makeStubContract(): any {
  return {
    address: AztecAddress.fromBigIntUnsafe(33n),
    methods: {
      claim: () => ({
        /* stub interaction — never invoked because sendAndWait is spied */
      }),
    },
  }
}

/**
 * Install a spy on the instance's `sendAndWait` that records the third arg
 * (the options object containing the merged `sendOptions`) and returns a
 * deterministic stub. Returns the captured-calls array for later assertion.
 */
function spySendAndWait(service: any): Array<any> {
  const calls: Array<any> = []
  service.sendAndWait = vi.fn((_initFn: any, _buildResult: any, opts: any) => {
    calls.push(opts)
    return {
      txPromise: Promise.resolve({ txHash: "0xstub", receipt: {} }),
      txHash: Promise.resolve("0xstub"),
    }
  })
  return calls
}

describe("PaylinkDirectClaimService.claimPayment — sendOptions spread", () => {
  let wallet: any
  let sender: any
  let recipient: any
  let contract: any
  let service: PaylinkDirectClaimService

  beforeEach(() => {
    wallet = makeStubWallet()
    sender = makeStubSender()
    recipient = makeStubRecipient()
    contract = makeStubContract()
    service = new PaylinkDirectClaimService(wallet, sender)
  })

  it("forwards operationId and kind to sendAndWait when caller passes them", async () => {
    const calls = spySendAndWait(service)
    await service.claimPayment(contract, undefined, recipient, TEE_CTX_STUB, {
      operationId: "op-direct-1",
      kind: "paylink-claim",
    })
    expect(calls).toHaveLength(1)
    // U5: operationId/kind are siblings of `sendOptions` on the `sendAndWait`
    // opts (not nested inside). `sendAndWait` merges them into the wallet-bound
    // `sendOptions` internally before `.send()`.
    expect(calls[0].operationId).toBe("op-direct-1")
    expect(calls[0].kind).toBe("paylink-claim")
  })

  it("omits operationId / kind when caller does not pass them (back-compat)", async () => {
    const calls = spySendAndWait(service)
    await service.claimPayment(contract, undefined, recipient, TEE_CTX_STUB)
    expect(calls).toHaveLength(1)
    expect(calls[0].operationId).toBeUndefined()
    expect(calls[0].kind).toBeUndefined()
  })

  it("preserves from = recipient.getAddress() and additionalScopes = [paylinkInstance.address]", async () => {
    const calls = spySendAndWait(service)
    await service.claimPayment(contract, undefined, recipient, TEE_CTX_STUB, {
      operationId: "op-direct-2",
      kind: "paylink-claim",
    })
    expect(calls[0].sendOptions.from).toEqual(recipient.getAddress())
    // `additionalScopes` carries the paylink-contract address from
    // `submitContext.paylinkInstance.address` — assembled by
    // `preparePaylinkClaimSubmit` regardless of the contract arg.
    expect(calls[0].sendOptions.additionalScopes).toEqual([TEE_CTX_STUB.paylinkInstance.address])
  })
})

describe("PaylinkEmailClaimService.claimPayment — sendOptions spread", () => {
  let wallet: any
  let sender: any
  let recipient: any
  let contract: any
  let service: PaylinkEmailClaimService

  // Build the proof shape the email leaf destructures: zkProof.{vkey,proof,public_inputs[6]}.
  // Each public_input is fed to `Fr.fromHexString` — provide minimal valid hex strings. The
  // caller slot (index 0) must be the recipient: the leaf asserts the proof binding.
  function makeStubProof(): any {
    const pi = Array.from({ length: 7 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, "0")}`)
    pi[0] = recipient.getAddress().toField().toString()
    return {
      zkProof: {
        vkey: "0x01",
        proof: ["0x02"],
        public_inputs: pi,
      },
    }
  }

  beforeEach(() => {
    wallet = makeStubWallet()
    sender = makeStubSender()
    recipient = makeStubRecipient()
    contract = {
      address: AztecAddress.fromBigIntUnsafe(44n),
      methods: {
        claim: (..._args: unknown[]) => ({}),
      },
    }
    service = new PaylinkEmailClaimService(wallet, sender)
  })

  it("forwards operationId and kind to sendAndWait when caller passes them", async () => {
    const calls = spySendAndWait(service)
    await service.claimPayment(contract, makeStubProof(), recipient, TEE_CTX_STUB, {
      operationId: "op-email-1",
      kind: "paylink-claim",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].operationId).toBe("op-email-1")
    expect(calls[0].kind).toBe("paylink-claim")
  })

  it("omits operationId / kind when caller does not pass them (back-compat)", async () => {
    const calls = spySendAndWait(service)
    await service.claimPayment(contract, makeStubProof(), recipient, TEE_CTX_STUB)
    expect(calls).toHaveLength(1)
    expect(calls[0].operationId).toBeUndefined()
    expect(calls[0].kind).toBeUndefined()
  })
})
