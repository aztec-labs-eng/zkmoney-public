import type { PaylinkWindow } from "@obsidion/core/types"
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import { PaylinkInitParams, PaylinkService } from "../../src/services/PaylinkService.js"
import { derivePaylinkKeys } from "../../src/services/paylink/paylinkKeys.js"
import { buildTransferMetaForSend } from "../../src/services/transferMeta.js"
import { TxHash } from "@aztec/stdlib/tx"
import { Fr } from "@aztec/aztec.js/fields"
import { Grumpkin } from "@aztec/foundation/crypto/grumpkin"
import { NO_FROM } from "@aztec/aztec.js/account"
import { Buffer } from "buffer"
import { readFileSync } from "fs"
import { resolve } from "path"
import { loadContractArtifact } from "@aztec/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec/stdlib/contract"
import type { NoirCompiledContract } from "@aztec/stdlib/noir"
import type { ContractArtifact } from "@aztec/aztec.js/abi"
import { EMAIL_LEN, poseidon2HashPackedString } from "../../src/email/utils.js"
import { DEFAULT_CONTRACTS, hashAndTruncate } from "../../src/index.js"
import type { ContractName, ContractService } from "../../src/index.js"
import { ZKJWT_VKEY_HASH } from "../../../core/src/constants/index.js"
import { AztecAddress } from "@aztec/aztec.js/addresses"

describe("PaylinkService Encryption and URL Tests", () => {
  const mockPaylinkParams = {
    secret: Fr.fromString("0x123456"),
    initHash: Fr.fromString("0xabcdef"),
    txHash: "0xtxhash123",
    paylinkType: "email",
    amount: BigInt(1000000),
    ciphertext: [Fr.fromString("0x111"), Fr.fromString("0x222")],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("escrow note read scopes", () => {
    it.each([false, true])("reads with an accountless visitor: %s", async (visitor) => {
      const accountAddress = visitor ? AztecAddress.ZERO : await AztecAddress.random()
      const escrow = await AztecAddress.random()
      const service = new PaylinkService(
        null as never,
        { getAddress: () => accountAddress } as never,
        null as never,
        null as never,
      )
      const simulate = vi.fn().mockResolvedValue({
        result: {
          data: new Fr(20n << 128n),
          refundable_until: Fr.ZERO,
          token_address: escrow,
          memo: Fr.ZERO,
        },
      })
      vi.spyOn(service, "reconstructPaylinkContract").mockResolvedValue({
        contract: { address: escrow, methods: { sync_note: () => ({ simulate }) } },
      } as never)
      const note = await service.sync_note({
        secret: Fr.random(),
        paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
        classId: Fr.ZERO,
        chainId: 31337,
        fallbackKeyHash: Fr.ZERO,
        rollupVersion: 1,
      })
      expect(note.amount).toBe(20n)
      expect(simulate).toHaveBeenCalledWith({
        from: visitor ? NO_FROM : accountAddress,
        additionalScopes: [escrow],
      })
    })
  })

  it.each([undefined, Fr.random().toString()])(
    "reads deposit metadata with optional tx hash %s",
    async (txHash) => {
      const escrow = await AztecAddress.random()
      const tokenAddress = await AztecAddress.random()
      const creator = await AztecAddress.random()
      const getPrivateEvents = vi.fn().mockResolvedValue([
        {
          event: {
            to: escrow,
            from: creator,
            meta: buildTransferMetaForSend({ memo: "lunch" }),
          },
        },
      ])
      const wallet = { getPrivateEvents }
      const service = new PaylinkService(
        wallet as never,
        null as never,
        { tokenAddress } as never,
        null as never,
      )
      // The deposit tx is what `reconstructPaylinkContract` found on chain, if anything yet.
      vi.spyOn(service, "reconstructPaylinkContract").mockResolvedValue({
        instance: { address: escrow },
        depositTxHash: txHash ? TxHash.fromString(txHash) : undefined,
      } as never)
      const result = await service.readDepositMeta({
        secret: Fr.random(),
        paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
        classId: Fr.ZERO,
        chainId: 31337,
        rollupVersion: 1,
      })
      expect(result?.memo).toBe("lunch")
      const filter = getPrivateEvents.mock.calls[0]![1]
      expect(filter).toMatchObject({ contractAddress: tokenAddress, scopes: [escrow] })
      expect(filter.txHash?.toString()).toBe(txHash)
    },
  )

  it("resolves a link's memo off the note's token when no token service names one", async () => {
    const escrow = await AztecAddress.random()
    const noteToken = await AztecAddress.random()
    const getPrivateEvents = vi.fn().mockResolvedValue([
      {
        event: {
          to: escrow,
          from: await AztecAddress.random(),
          meta: buildTransferMetaForSend({ memo: "lunch" }),
        },
      },
    ])
    // The visitor page's placeholder service: no account, no token service.
    const service = new PaylinkService(
      { getPrivateEvents } as never,
      null as never,
      {} as never,
      null as never,
    )
    vi.spyOn(service, "reconstructPaylinkContract").mockResolvedValue({
      instance: { address: escrow },
    } as never)
    const internals = service as unknown as {
      readEscrowNote: () => Promise<unknown>
      registerToken: (token: AztecAddress) => Promise<void>
    }
    vi.spyOn(internals, "readEscrowNote").mockResolvedValue({
      tokenAddress: noteToken,
      hash: Fr.ZERO,
    })
    const registerToken = vi.spyOn(internals, "registerToken").mockResolvedValue()
    const resolved = await service.resolveLink({
      secret: Fr.random(),
      paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
      classId: Fr.ZERO,
      chainId: 31337,
      rollupVersion: 1,
    })
    expect(resolved.memo).toBe("lunch")
    expect(registerToken).toHaveBeenCalledWith(noteToken)
    expect(getPrivateEvents.mock.calls[0]![1]).toMatchObject({
      contractAddress: noteToken,
      scopes: [escrow],
    })
  })

  describe("serverless link (generate + parse)", () => {
    it("generates an inline link and parses it back to the original params", async () => {
      const keys = await derivePaylinkKeys({ secretKey: Fr.random(), fallbackSecret: Fr.random() })
      const params = {
        secret: Fr.random(),
        paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
        classId: Fr.random(),
        chainId: 11155111,
        fallbackKeyHash: keys.fallbackKeyHash,
        rollupVersion: 1,
        escrowTagSecret: Grumpkin.generator,
      }

      const service = new PaylinkService(null as any, null as any, null as any, null as any)
      const url = await service.generatePaymentLink(params)

      expect(url).toContain("paylink.zk.money/claim#")
      expect(url.split("#")).toHaveLength(2)

      const parsed = await PaylinkService.parsePaylinkUrl(url)
      expect(parsed.secret.toString()).toBe(params.secret.toString())
      expect(parsed.paylinkType).toBe(params.paylinkType)
      expect(parsed.classId.toString()).toBe(params.classId.toString())
      expect(parsed.chainId).toBe(params.chainId)
      expect(parsed.fallbackKeyHash.equals(params.fallbackKeyHash)).toBe(true)
      expect(parsed.escrowTagSecret?.equals(params.escrowTagSecret)).toBe(true)
    })

    it("throws on a URL with no fragment", async () => {
      await expect(
        PaylinkService.parsePaylinkUrl("https://paylink.zk.money/claim"),
      ).rejects.toThrow("Invalid paylink URL format")
    })
  })

  describe("Compute Commitment Hash", () => {
    let service: PaylinkService

    beforeEach(() => {
      service = new PaylinkService(null as any, null as any, null as any, null as any, null as any)
    })

    it("should compute the commitment hash for an email paylink", async () => {
      const input = { email: "test@example.com" }
      const commitmentHash = await service.computeCommitmentHash(
        DEFAULT_CONTRACTS.paylinkEmail,
        input,
      )
      expect(commitmentHash).toBeDefined()

      // reconstruct the commitment by hand
      const emailHash = poseidon2HashPackedString(input.email, EMAIL_LEN)
      expect(emailHash).toBe(commitmentHash)
    })

    it("should reject non-string email input", async () => {
      const input1 = { email: 123 }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input1 as any),
      ).rejects.toThrow("Email must be a string")

      const input2 = { email: [1, 2, 3] }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input2 as any),
      ).rejects.toThrow("Email must be a string")

      const input3 = { email: { name: "John" } }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input3 as any),
      ).rejects.toThrow("Email must be a string")

      const input4 = { email: null }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input4 as any),
      ).rejects.toThrow("Email must be a string")

      const input5 = { email: undefined }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input5 as any),
      ).rejects.toThrow("Email must be a string")
    })

    it("should reject empty email input", async () => {
      const input1 = { email: "" }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input1),
      ).rejects.toThrow("Email must not be empty")

      const input2 = { email: "   " }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input2),
      ).rejects.toThrow("Email must not be empty")
    })

    it("should reject invalid email format", async () => {
      const input1 = { email: "notanemail" }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input1),
      ).rejects.toThrow("Email must be valid")

      const input2 = { email: "@example.com" }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input2),
      ).rejects.toThrow("Email must have characters before @")

      const input3 = { email: "test@" }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input3),
      ).rejects.toThrow("Email must have characters after @")
    })

    it("should reject email that exceeds byte length", async () => {
      // Create an email that's longer than 64 bytes
      const longEmail = "a".repeat(60) + "@example.com" // This will exceed 64 bytes
      const input = { email: longEmail }
      await expect(
        service.computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, input),
      ).rejects.toThrow("exceeds 64 byte limit")
    })
  })

  describe("Getting contract name for type", () => {
    let service: PaylinkService

    beforeEach(() => {
      service = new PaylinkService(null as any, null as any, null as any, null as any, null as any)
    })

    it("should get correct name for paylink types", async () => {
      const name = service.getContractNameForType(DEFAULT_CONTRACTS.paylinkEmail)
      expect(name).toBe(DEFAULT_CONTRACTS.paylinkEmail)

      const name2 = service.getContractNameForType(DEFAULT_CONTRACTS.paylinkDirect)
      expect(name2).toBe(DEFAULT_CONTRACTS.paylinkDirect)
    })

    it("should throw error for unsupported paylink type", () => {
      expect(() => service.getContractNameForType("unsupported" as any)).toThrow(
        "Unsupported paylink type: unsupported",
      )
    })
  })

  describe("Getting constructor arguments for type", async () => {
    let service: PaylinkService
    let mockEmailInput: PaylinkInitParams

    mockEmailInput = {
      amount: BigInt(1000000),
      hash: Fr.random(),
      token: await AztecAddress.random(),
      window: {
        fromClaimable: BigInt(1718582400),
        untilClaimable: BigInt(1718582400) + BigInt(86400),
        refundableUntil: 0n,
      },
      registry_address: await AztecAddress.random(),
      vkey_hash: Fr.fromHexString(ZKJWT_VKEY_HASH),
    }

    const senderAddress = await AztecAddress.random()
    const mockSender = { getAddress: () => senderAddress }

    beforeEach(() => {
      service = new PaylinkService(
        null as any,
        mockSender as any,
        null as any,
        null as any,
        null as any,
      )
    })

    it("should get correct constructor arguments for email paylink", async () => {
      const args = service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, mockEmailInput)
      expect(args).toEqual([
        mockEmailInput.amount,
        mockEmailInput.registry_address,
        mockEmailInput.vkey_hash,
        mockEmailInput.hash,
        mockEmailInput.window.fromClaimable,
        mockEmailInput.window.untilClaimable,
        mockEmailInput.window.refundableUntil,
        mockEmailInput.token,
        senderAddress,
        buildTransferMetaForSend({}),
      ])
    })

    it("passes the memo as the trailing deposit meta", async () => {
      const args = service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, {
        ...mockEmailInput,
        memo: "hi",
      })
      expect(args.at(-1)).toEqual(buildTransferMetaForSend({ memo: "hi" }))
    })

    it("passes an explicit funding meta through as the trailing deposit arg", async () => {
      const meta = [new Fr(7n)]
      const args = service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, mockEmailInput, meta)
      expect(args.at(-1)).toBe(meta)
    })

    it("should reject a missing sender for email paylink", () => {
      const senderless = new PaylinkService(
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
      )
      expect(() =>
        senderless.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, mockEmailInput),
      ).toThrow("email paylink requires a sender")
    })

    it("should reject non-bigint amount", () => {
      const invalidInput = {
        ...mockEmailInput,
        amount: "1000000" as any,
      }
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, invalidInput),
      ).toThrow("amount must be a bigint")

      const invalidInput2 = {
        ...mockEmailInput,
        amount: 1000000 as any,
      }
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, invalidInput2),
      ).toThrow("amount must be a bigint")
    })

    it("should reject zero or negative amount", () => {
      const invalidInput = {
        ...mockEmailInput,
        amount: 0n,
      }
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, invalidInput),
      ).toThrow("amount must be greater than 0")

      const invalidInput2 = {
        ...mockEmailInput,
        amount: -100n,
      }
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, invalidInput2),
      ).toThrow("amount must be greater than 0")
    })

    it("should reject missing hash", () => {
      const invalidInput = {
        ...mockEmailInput,
        hash: null as any,
      }
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, invalidInput),
      ).toThrow("hash must be provided")

      const invalidInput2 = {
        ...mockEmailInput,
        hash: undefined as any,
      }
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, invalidInput2),
      ).toThrow("hash must be provided")
    })

    it("should reject missing token", () => {
      const invalidInput = {
        ...mockEmailInput,
        token: null as any,
      }
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, invalidInput),
      ).toThrow("token must be provided")
    })

    const withWindow = (over: Partial<PaylinkWindow>) => ({
      ...mockEmailInput,
      window: { ...mockEmailInput.window, ...over },
    })

    it("should reject non-bigint timestamps", () => {
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ fromClaimable: "123456" as any }),
        ),
      ).toThrow("fromClaimable must be a bigint")
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ untilClaimable: 123456 as any }),
        ),
      ).toThrow("untilClaimable must be a bigint")
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ refundableUntil: 1 as any }),
        ),
      ).toThrow("refundableUntil must be a bigint")
    })

    it("should reject negative timestamps", () => {
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ fromClaimable: -1n }),
        ),
      ).toThrow("fromClaimable must be non-negative")
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ untilClaimable: -1n }),
        ),
      ).toThrow("untilClaimable must be non-negative")
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ refundableUntil: -1n }),
        ),
      ).toThrow("refundableUntil must be non-negative")
    })

    it("should reject invalid timestamp range", () => {
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ fromClaimable: 1000n, untilClaimable: 500n, refundableUntil: 0n }),
        ),
      ).toThrow("untilClaimable must be greater than fromClaimable")
    })

    it("should reject a refund window outliving the claim window", () => {
      expect(() =>
        service.getConstructorArgs(
          DEFAULT_CONTRACTS.paylinkEmail,
          withWindow({ refundableUntil: mockEmailInput.window.untilClaimable + 1n }),
        ),
      ).toThrow("refundableUntil must not exceed untilClaimable")
    })
  })
})

describe("escrow class assertion", () => {
  // The artifact this binary would bundle, and the class derived from it — the value the assert
  // compares against in either mode. Read rather than hardcoded, so a recompile moves both sides.
  let artifact: ContractArtifact
  let artifactClassId: string

  beforeAll(async () => {
    artifact = loadContractArtifact(
      JSON.parse(
        readFileSync(
          resolve(
            __dirname,
            "../../../contracts/src/artifacts/target/paylink_direct/paylink_direct-PaylinkDirect.json",
          ),
          "utf-8",
        ),
      ) as NoirCompiledContract,
    )
    artifactClassId = (await getContractClassFromArtifact(artifact)).id.toString()
  })

  /** A contract service that serves one artifact and whatever class id the config states. */
  const fakeContractService = (configuredClassId?: string | Error) =>
    ({
      getArtifactForContract: async () => artifact,
      getConfiguredClassId: () => {
        if (configuredClassId instanceof Error) throw configuredClassId
        return configuredClassId
      },
    } as unknown as ContractService)

  const derive = async (
    contractService: ContractService,
    type: ContractName = DEFAULT_CONTRACTS.paylinkDirect,
  ) => {
    const service = new PaylinkService(null as any, null as any, null as any, contractService)
    const paylinkKeys = await derivePaylinkKeys({
      secretKey: Fr.random(),
      fallbackSecret: Fr.random(),
    })
    return service.getContractInstance(type, [], undefined, paylinkKeys)
  }

  it("compares against the served class id when a config states one", async () => {
    const { instance } = await derive(fakeContractService(artifactClassId))
    expect(instance.currentContractClassId.toString()).toBe(artifactClassId)
  })

  it("accepts a served class id in upper case", async () => {
    const upper = `0x${artifactClassId.slice(2).toUpperCase()}`
    await expect(derive(fakeContractService(upper))).resolves.toBeDefined()
  })

  it("rejects a served class id the binary does not compile to, naming both", async () => {
    const served = `0x${"9".repeat(64)}`
    await expect(derive(fakeContractService(served))).rejects.toThrow(served)
    await expect(derive(fakeContractService(served))).rejects.toThrow(artifactClassId)
  })

  it("fails closed when the config states no class for a supported type", async () => {
    const refused = new Error("The config profile states no class id for paylinkDirect")
    await expect(derive(fakeContractService(refused))).rejects.toThrow(/states no class id/)
  })

  it("skips the assert on a local-ledger service, which states no class ids", async () => {
    const { instance } = await derive(fakeContractService(undefined))
    expect(instance.currentContractClassId.toString()).toBe(artifactClassId)
  })
})
