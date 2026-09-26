import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the vendor modules. `FleetSigner.connect` is what does the real
// work (HTTP roundtrip + attestation cross-check); the vendor already tests
// that behaviour. Our wrapper's responsibility is: build the portal, plumb
// the URL + options, and propagate errors. Test the boundary, not the
// upstream business logic.

vi.mock("@oxide/oxide-client/fleet_signer.js", () => ({
  FleetSigner: {
    connect: vi.fn(),
  },
}))

vi.mock("@oxide/l1-contracts/oxide_portal.js", () => ({
  OxidePortalContract: vi.fn(),
}))

vi.mock("../../src/services/teeSignerApproval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/teeSignerApproval.js")>()),
  assertTeeSignerApproved: vi.fn(),
}))

import { FleetSigner } from "@oxide/oxide-client/fleet_signer.js"
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import { loadTeeSigner } from "../../src/services/teeOperation.js"
import {
  assertTeeSignerApproved,
  onTeeSignerRefused,
  TeeSignerNotApprovedError,
} from "../../src/services/teeSignerApproval.js"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { EthAddress } from "@aztec/foundation/eth-address"
import { ServiceBase } from "../../src/services/ServiceBase.js"
import type { TeeSigner } from "@oxide/oxide-lib/types.js"

const FAKE_PORTAL_ADDRESS = "0x10c20f5ec11aa51de97edd0cfb01bfcb11e8fbf3" as const
const FAKE_VIEM_CLIENT = { chain: { id: 11155111 } } as any

function makeFakeSigner(overrides: Partial<TeeSigner> = {}): TeeSigner {
  return {
    publicKey: { x: 0n, y: 0n } as any,
    ethAddress: { toString: () => "0xabcd" } as any,
    encryptionPublicKey: {} as any,
    signTokenOperation: vi.fn(),
    signWithdrawalFinalization: vi.fn(),
    signFrozenNotesRefundFinalization: vi.fn(),
    signFrozenDepositRefundFinalization: vi.fn(),
    signUnprocessedDepositRefundFinalization: vi.fn(),
    ...overrides,
  } as TeeSigner
}

describe("loadTeeSigner (SDK helper)", () => {
  beforeEach(() => {
    vi.mocked(FleetSigner.connect).mockReset()
    vi.mocked(OxidePortalContract).mockReset()
    vi.mocked(assertTeeSignerApproved).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("loadTeeSigner", () => {
    it("constructs OxidePortalContract from the viem client + portal address, then delegates to connect with oxide's default timeouts", async () => {
      const fakePortal = { __tag: "portal" } as any
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => fakePortal)
      const fakeSigner = makeFakeSigner()
      vi.mocked(FleetSigner.connect).mockResolvedValueOnce(fakeSigner as any)

      const result = await loadTeeSigner(
        "http://enclave/rpc",
        FAKE_PORTAL_ADDRESS,
        FAKE_VIEM_CLIENT,
      )

      expect(result).toBe(fakeSigner)
      expect(OxidePortalContract).toHaveBeenCalledTimes(1)
      expect(OxidePortalContract).toHaveBeenCalledWith(FAKE_VIEM_CLIENT, FAKE_PORTAL_ADDRESS)
      expect(FleetSigner.connect).toHaveBeenCalledTimes(1)
      expect(FleetSigner.connect).toHaveBeenCalledWith("http://enclave/rpc", fakePortal, {})
    })

    it("forwards explicit timeouts + maxAttempts overrides", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      vi.mocked(FleetSigner.connect).mockResolvedValueOnce(makeFakeSigner() as any)

      await loadTeeSigner("http://enclave/rpc", FAKE_PORTAL_ADDRESS, FAKE_VIEM_CLIENT, {
        timeouts: { operationMs: 50 },
        maxAttempts: 1,
      })

      expect(FleetSigner.connect).toHaveBeenCalledTimes(1)
      expect(FleetSigner.connect).toHaveBeenCalledWith("http://enclave/rpc", expect.any(Object), {
        timeouts: { operationMs: 50 },
        maxAttempts: 1,
      })
    })

    it("propagates errors from FleetSigner.connect (does not swallow)", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      const bindingMissing = new Error("TEE 0xabcd not registered in portal")
      vi.mocked(FleetSigner.connect).mockRejectedValueOnce(bindingMissing)

      await expect(
        loadTeeSigner("http://enclave/rpc", FAKE_PORTAL_ADDRESS, FAKE_VIEM_CLIENT),
      ).rejects.toThrow("TEE 0xabcd not registered in portal")
    })

    it("propagates PCR0 / attestation mismatch errors", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      vi.mocked(FleetSigner.connect).mockRejectedValueOnce(
        new Error("TEE 0xdead PCR0 not approved in portal"),
      )

      await expect(
        loadTeeSigner("http://enclave/rpc", FAKE_PORTAL_ADDRESS, FAKE_VIEM_CLIENT),
      ).rejects.toThrow("PCR0 not approved")
    })

    it("does not touch the node when no l2Approval is requested", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      vi.mocked(FleetSigner.connect).mockResolvedValueOnce(makeFakeSigner() as any)

      await loadTeeSigner("http://enclave/rpc", FAKE_PORTAL_ADDRESS, FAKE_VIEM_CLIENT)

      expect(assertTeeSignerApproved).not.toHaveBeenCalled()
    })

    it("with l2Approval, checks the pinned key against the token at the latest block", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      const fakeSigner = makeFakeSigner()
      vi.mocked(FleetSigner.connect).mockResolvedValueOnce(fakeSigner as any)
      const latestHash = { __tag: "latest-hash" }
      const node = {
        getBlockData: vi.fn(async () => ({ header: { hash: async () => latestHash } })),
        getPublicDataWitness: vi.fn(),
      }
      const tokenAddress = AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01")

      const result = await loadTeeSigner(
        "http://enclave/rpc",
        FAKE_PORTAL_ADDRESS,
        FAKE_VIEM_CLIENT,
        {
          l2Approval: { node: node as any, tokenAddress },
        },
      )

      expect(result).toBe(fakeSigner)
      expect(node.getBlockData).toHaveBeenCalledWith("latest")
      expect(assertTeeSignerApproved).toHaveBeenCalledWith({
        node,
        tokenAddress,
        publicKey: fakeSigner.publicKey,
        blockHash: latestHash,
      })
      // The approval options never leak into the fleet connect.
      expect(FleetSigner.connect).toHaveBeenCalledWith("http://enclave/rpc", expect.any(Object), {})
    })

    it("with l2Approval, rejects with the typed refusal and returns no signer", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      vi.mocked(FleetSigner.connect).mockResolvedValueOnce(makeFakeSigner() as any)
      const tokenAddress = AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01")
      const refusal = new TeeSignerNotApprovedError(tokenAddress, EthAddress.random(), "0x01")
      vi.mocked(assertTeeSignerApproved).mockRejectedValueOnce(refusal)
      const node = {
        getBlockData: vi.fn(async () => ({ header: { hash: async () => ({}) } })),
        getPublicDataWitness: vi.fn(),
      }

      const refused = vi.fn()
      const off = onTeeSignerRefused(refused)
      try {
        await expect(
          loadTeeSigner("http://enclave/rpc", FAKE_PORTAL_ADDRESS, FAKE_VIEM_CLIENT, {
            l2Approval: { node: node as any, tokenAddress },
          }),
        ).rejects.toBe(refusal)
      } finally {
        off()
      }
      // A connect-time refusal is the caller's rejection; only a sign-time one has an owner to tell.
      expect(refused).not.toHaveBeenCalled()
    })

    it("with l2Approval, fails closed when the node has no latest block", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      vi.mocked(FleetSigner.connect).mockResolvedValueOnce(makeFakeSigner() as any)
      const node = { getBlockData: vi.fn(async () => undefined), getPublicDataWitness: vi.fn() }

      await expect(
        loadTeeSigner("http://enclave/rpc", FAKE_PORTAL_ADDRESS, FAKE_VIEM_CLIENT, {
          l2Approval: {
            node: node as any,
            tokenAddress: AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01"),
          },
        }),
      ).rejects.toThrow(/no latest block/)
      expect(assertTeeSignerApproved).not.toHaveBeenCalled()
    })

    it("propagates timeout / abort errors", async () => {
      vi.mocked(OxidePortalContract).mockImplementationOnce(() => ({} as any))
      vi.mocked(FleetSigner.connect).mockRejectedValueOnce(
        new Error("Enclave RPC timed out after 50ms"),
      )

      await expect(
        loadTeeSigner("http://enclave/rpc", FAKE_PORTAL_ADDRESS, FAKE_VIEM_CLIENT, {
          timeouts: { operationMs: 50 },
        }),
      ).rejects.toThrow("Enclave RPC timed out after 50ms")
    })
  })
})

describe("ServiceBase.setTeeSigner clear path", () => {
  // Concrete subclass — ServiceBase is abstract on the `wallet` field type
  // (ObsidionWallet); we only need a smoke harness around setTeeSigner /
  // getTeeSigner here, so the wallet value is irrelevant.
  class TestService extends ServiceBase {
    constructor() {
      super({} as any)
    }
    /** Expose the protected getTeeSigner for the assertion. */
    public probe(): TeeSigner {
      return (this as any).getTeeSigner()
    }
  }

  it("setTeeSigner(undefined) clears a previously-wired signer", () => {
    const service = new TestService()
    const signer = makeFakeSigner()

    service.setTeeSigner(signer)
    expect(service.probe()).toBe(signer)

    service.setTeeSigner(undefined)
    expect(() => service.probe()).toThrow(/TEE signer not wired/)
  })

  it("setTeeSigner(signer) replaces a previously-wired signer", () => {
    const service = new TestService()
    const signerA = makeFakeSigner({ signTokenOperation: vi.fn() as any })
    const signerB = makeFakeSigner({ signTokenOperation: vi.fn() as any })

    service.setTeeSigner(signerA)
    expect(service.probe()).toBe(signerA)

    service.setTeeSigner(signerB)
    expect(service.probe()).toBe(signerB)
  })
})
