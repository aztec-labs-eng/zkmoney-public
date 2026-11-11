import { describe, expect, it } from "vitest"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  ContractService,
  DEFAULT_CONTRACTS,
  Network,
  NodeContractServiceStorage,
} from "@obsidion/contracts"
import type { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { ServiceBase, ServiceContractBase } from "../../src/services/ServiceBase.js"

const fakeSigner = () => ({} as RegisteredTeeSigner)
const TOKEN = AztecAddress.fromStringUnsafe(`0x${"07".repeat(32)}`)

describe("ServiceBase.setTeeSigner clear path", () => {
  class TestService extends ServiceBase {
    constructor() {
      super({} as never)
    }
    public probe(): RegisteredTeeSigner {
      return this.getTeeSigner()
    }
  }

  it("setTeeSigner(undefined) clears a previously-wired signer", () => {
    const service = new TestService()
    const signer = fakeSigner()

    service.setTeeSigner(signer)
    expect(service.probe()).toBe(signer)

    service.setTeeSigner(undefined)
    expect(() => service.probe()).toThrow(/TEE signer not wired/)
  })

  it("setTeeSigner(signer) replaces a previously-wired signer", () => {
    const service = new TestService()
    const signerA = fakeSigner()
    const signerB = fakeSigner()

    service.setTeeSigner(signerA)
    expect(service.probe()).toBe(signerA)

    service.setTeeSigner(signerB)
    expect(service.probe()).toBe(signerB)
  })
})

describe("ServiceContractBase registration", () => {
  class TokenProbe extends ServiceContractBase {
    constructor(wallet: ObsidionWallet) {
      super(DEFAULT_CONTRACTS.oxideToken, wallet)
    }
    public registered(): Promise<void> {
      return this.ensureContractsRegistered()
    }
  }

  /** A wallet over its own contract service and an empty PXE that counts registrations. */
  async function walletWithPxe() {
    const pxe = {
      registered: 0,
      getContractArtifact: async () => undefined,
      getContractInstance: async () => undefined,
      registerContractClass: async () => {},
      registerContract: async () => {
        pxe.registered++
      },
    }
    const node = {
      getContract: async (address: AztecAddress) => ({
        address,
        currentContractClassId: "token-class",
        originalContractClassId: "token-class",
      }),
    }
    const contractService = new ContractService(
      new NodeContractServiceStorage(Network.TESTNET),
      node as never,
      pxe as never,
      Network.TESTNET,
      { source: "local-ledger", oxideEnvProfile: null },
    )
    await contractService.setContractAddress(DEFAULT_CONTRACTS.oxideToken, TOKEN)
    return { wallet: { contractService } as unknown as ObsidionWallet, pxe }
  }

  it("registers a contract in each wallet's PXE", async () => {
    const first = await walletWithPxe()
    const second = await walletWithPxe()
    await new TokenProbe(first.wallet).registered()
    await new TokenProbe(second.wallet).registered()
    expect(first.pxe.registered).toBe(1)
    expect(second.pxe.registered).toBe(1)
  })
})
