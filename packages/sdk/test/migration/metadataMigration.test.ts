import { describe, expect, it, vi } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { recoverAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem"
import {
  decodeMetadataUpdateIntentData,
  decodeMetadataUpdateProofs,
  decodeUserRecordMetadata,
  metadataUpdateDigest,
  oxideAccountPersonalSignDigest,
} from "@oxide/l1-contracts"
import {
  assertMetadataUpdateFresh,
  prepareMetadataUpdate,
  type MetadataDestination,
} from "../../src/services/metadataMigration.js"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const field = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const destination: MetadataDestination = {
  chainId: 31337n,
  rollupVersion: 5n,
  nameRegistry: addr(1),
  metadataRegistry: addr(2),
  controller: addr(3),
  factory: addr(4),
  portal: addr(5),
  implementation: addr(6),
  namePortal: addr(7),
  token: addr(17),
  depositSubsidy: addr(18),
  operationExecutor: addr(19),
}
const bootstrap = privateKeyToAccount(field(123))

function fixture() {
  const state = {
    registry: destination.metadataRegistry,
    hash: zeroHash,
    implementation: destination.implementation,
    consent: "0x1626ba7e" as Hex,
  }
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "accountMetadataRegistry":
        return state.registry
      case "registrationController":
        return destination.controller
      case "implementationFor":
        return state.implementation
      case "nameOf":
        return field(9)
      case "metadataStateHash":
        return state.hash
      case "predictSIPA":
        return addr(10)
      case "depositFee":
        return 500_000_000_000_000_000n
      case "FPC_FUNDING_CUT":
        return 50_000_000_000_000_000n
      case "isValidSignature":
        return state.consent
      default:
        throw new Error(`Unexpected read: ${functionName}`)
    }
  })
  const client = { getChainId: async () => 31337, readContract } as unknown as PublicClient
  const signConsent = vi.fn((hash: Hex) => bootstrap.sign({ hash }))
  const args = {
    client,
    destination,
    owner: addr(11),
    record: {
      l2Address: field(12),
      rollupVersion: 5n,
      publicKey: { x: 21n, y: 22n },
      resolverOperator: addr(13),
    },
    fpc: field(14),
    recipientCommitment: field(15),
    recoveryCommitment: field(16),
    signConsent,
  }
  return { state, args, readContract, signConsent }
}

describe("metadata migration destination adapter", () => {
  it.each([zeroHash, field(99)])(
    "prepares against destination state %s without reading a legacy record",
    async (hash) => {
      const { state, args, readContract, signConsent } = fixture()
      state.hash = hash
      const prepared = await prepareMetadataUpdate(args)
      const decoded = decodeMetadataUpdateIntentData(prepared.intentData)
      expect(decoded.expectedStateHash).toBe(hash)
      expect(decodeUserRecordMetadata(decoded.metadata)).toEqual(args.record)
      expect(prepared.deployArgs.resweepable).toBe(false)
      expect(prepared.fee).toBe(550_000_000_000_000_000n)
      expect(readContract.mock.calls.every(([call]) => call.functionName !== "userRecords")).toBe(
        true,
      )
      const update = metadataUpdateDigest({
        chainId: destination.chainId,
        nameRegistry: destination.nameRegistry,
        sipa: prepared.sipa,
        intentData: prepared.intentData,
      })
      const digest = oxideAccountPersonalSignDigest({
        chainId: destination.chainId,
        account: args.owner,
        digest: update,
      })
      const signature = decodeMetadataUpdateProofs(prepared.proofs)
      expect(signConsent).toHaveBeenCalledWith(digest)
      expect(await recoverAddress({ hash: digest, signature })).toBe(bootstrap.address)
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: args.owner,
          functionName: "isValidSignature",
          args: [update, signature],
        }),
      )
    },
  )

  it("rejects a registry change during the consent ceremony", async () => {
    const { state, args } = fixture()
    args.signConsent = vi.fn(async (hash: Hex) => {
      state.registry = addr(90)
      return bootstrap.sign({ hash })
    })
    await expect(prepareMetadataUpdate(args)).rejects.toThrow("registry or controller changed")
  })

  it("refuses consent the registered account rejects", async () => {
    const { state, args } = fixture()
    state.consent = "0xffffffff"
    await expect(prepareMetadataUpdate(args)).rejects.toThrow("rejected metadata consent")
  })

  it("rechecks the record before broadcast", async () => {
    const { state, args } = fixture()
    const prepared = await prepareMetadataUpdate(args)
    state.hash = field(98)
    await expect(assertMetadataUpdateFresh(args.client, prepared)).rejects.toThrow(
      "metadata changed",
    )
  })

  it("refuses a factory without the advertised implementation before signing", async () => {
    const { state, args, signConsent } = fixture()
    state.implementation = addr(0)
    await expect(prepareMetadataUpdate(args)).rejects.toThrow("factory")
    expect(signConsent).not.toHaveBeenCalled()
  })
})
