import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { privateKeyToAccount } from "viem/accounts"
import { zeroHash, type Address, type Hex, type PublicClient } from "viem"

vi.mock("../../src/services/sipaIntents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/sipaIntents.js")>()),
  assertSubsidySweepsSipa: vi.fn(async () => {}),
  buildSipaBroadcast: vi.fn(() => [{ request: async () => ({ calls: [{ to: "sipa" }] }) }]),
}))
vi.mock("@oxide/oxide-client/broadcaster_calls.js", () => ({
  broadcastL1Operation: vi.fn(() => ({ request: async () => ({ calls: [{ to: "refund" }] }) })),
}))
vi.mock("../../src/services/claimSponsor.js", () => ({ hasClaimFpcSubscription: vi.fn() }))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSubscribePayload: vi.fn(async () => ({ rail: "subscribe" })),
  buildClaimSponsorPayload: vi.fn(async () => ({ rail: "sponsor" })),
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: vi.fn(() => ({})),
}))

import {
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
} from "../../src/feePaymentMethod/claimSponsoredCall.js"
import { hasClaimFpcSubscription } from "../../src/services/claimSponsor.js"
import {
  prepareMetadataUpdate,
  type MetadataDestination,
} from "../../src/services/metadataMigration.js"
import {
  prepareMigrationBootstrap,
  type MigrationBootstrapOptions,
} from "../../src/services/migrationBootstrap.js"
import { computeStealthRecipientHash } from "../../src/services/sipaStealth.js"

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
const user = AztecAddress.fromBigIntUnsafe(12n)
const fpcAddress = AztecAddress.fromBigIntUnsafe(14n)
const messageSecret = new Fr(15n)

async function fixture() {
  const state = { hash: zeroHash as Hex }
  const client = {
    getChainId: async () => 31337,
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "accountMetadataRegistry":
          return destination.metadataRegistry
        case "registrationController":
          return destination.controller
        case "implementationFor":
          return destination.implementation
        case "nameOf":
          return field(9)
        case "metadataStateHash":
          return state.hash
        case "predictSIPA":
          return addr(10)
        case "depositFee":
          return 500n
        case "FPC_FUNDING_CUT":
          return 50n
        case "isValidSignature":
          return "0x1626ba7e"
        default:
          throw new Error(`Unexpected read: ${functionName}`)
      }
    }),
  } as unknown as PublicClient
  const metadata = await prepareMetadataUpdate({
    client,
    destination,
    owner: addr(11),
    record: {
      l2Address: user.toString(),
      rollupVersion: 5n,
      publicKey: { x: 21n, y: 22n },
      resolverOperator: addr(13),
    },
    fpc: fpcAddress.toString(),
    recipientCommitment: (await computeStealthRecipientHash(messageSecret, user)).toString(),
    recoveryCommitment: field(16),
    signConsent: (hash) => privateKeyToAccount(field(123)).sign({ hash }),
  })
  const findLeavesIndexes = vi.fn(async () => [undefined] as (bigint | undefined)[])
  const args: MigrationBootstrapOptions = {
    client,
    wallet: { node: { findLeavesIndexes } } as never,
    metadata,
    token: {} as never,
    broadcaster: {} as never,
    messageSecret,
    sponsorship: { kind: "bootstrap", gate: { kind: "nameClaim" } as never },
    fpc: { fpcAddress, user, railId: 1 } as never,
  }
  vi.mocked(buildClaimSubscribePayload).mockClear()
  vi.mocked(buildClaimSponsorPayload).mockClear()
  vi.mocked(hasClaimFpcSubscription).mockReset()
  return { state, args, findLeavesIndexes }
}

const noPayload = () => {
  expect(buildClaimSubscribePayload).not.toHaveBeenCalled()
  expect(buildClaimSponsorPayload).not.toHaveBeenCalled()
}

describe("migration bootstrap preparation", () => {
  it("prepares on the unspent bootstrap rail, the refund broadcast first", async () => {
    const { args, findLeavesIndexes } = await fixture()
    const prepared = await prepareMigrationBootstrap(args)
    expect(findLeavesIndexes).toHaveBeenCalledOnce()
    expect(prepared.payload).toEqual({ rail: "subscribe" })
    expect(prepared.innerCalls).toEqual([{ to: "sipa" }])
    expect(buildClaimSponsorPayload).not.toHaveBeenCalled()
    // Any broadcast operation stands in for the source refund.
    const refunded = await prepareMigrationBootstrap({
      ...args,
      refund: prepared.metadataOperation,
    })
    expect(refunded.innerCalls).toEqual([{ to: "refund" }, { to: "sipa" }])
  })

  it("prepares on the registered rail without reading the bootstrap allowance", async () => {
    const { args, findLeavesIndexes } = await fixture()
    vi.mocked(hasClaimFpcSubscription).mockResolvedValue(true)
    const prepared = await prepareMigrationBootstrap({
      ...args,
      sponsorship: { kind: "registered" },
    })
    expect(prepared.payload).toEqual({ rail: "sponsor" })
    expect(findLeavesIndexes).not.toHaveBeenCalled()
    expect(buildClaimSubscribePayload).not.toHaveBeenCalled()
  })

  it("refuses a bootstrap gate other than NameClaim", async () => {
    const { args } = await fixture()
    const sponsorship = { kind: "bootstrap", gate: { kind: "password" } } as never
    await expect(prepareMigrationBootstrap({ ...args, sponsorship })).rejects.toThrow("NameClaim")
    noPayload()
  })

  it("refuses an identity that already spent its bootstrap allowance", async () => {
    const { args, findLeavesIndexes } = await fixture()
    findLeavesIndexes.mockResolvedValue([0n])
    await expect(prepareMigrationBootstrap(args)).rejects.toThrow("already spent")
    noPayload()
  })

  it("refuses the registered rail without a subscription", async () => {
    const { args } = await fixture()
    vi.mocked(hasClaimFpcSubscription).mockResolvedValue(false)
    await expect(
      prepareMigrationBootstrap({ ...args, sponsorship: { kind: "registered" } }),
    ).rejects.toThrow("no registered sponsorship subscription")
    noPayload()
  })

  it.each([
    ["deposit secret", { messageSecret: new Fr(99n) }],
    ["sponsored account", { user: AztecAddress.fromBigIntUnsafe(98n) }],
  ])("refuses a %s the metadata does not name", async (_, change) => {
    const { args } = await fixture()
    await expect(
      prepareMigrationBootstrap({
        ...args,
        messageSecret: "messageSecret" in change ? change.messageSecret : args.messageSecret,
        fpc: "user" in change ? { ...args.fpc, user: change.user } : args.fpc,
      }),
    ).rejects.toThrow("must name the same recipient")
    noPayload()
  })

  it("refuses an FPC the metadata attestation does not name", async () => {
    const { args } = await fixture()
    const fpc = { ...args.fpc, fpcAddress: AztecAddress.fromBigIntUnsafe(97n) }
    await expect(prepareMigrationBootstrap({ ...args, fpc })).rejects.toThrow(
      "different destination FPC",
    )
    noPayload()
  })

  it("refuses destination metadata that changed after preparation", async () => {
    const { state, args } = await fixture()
    state.hash = field(98)
    await expect(prepareMigrationBootstrap(args)).rejects.toThrow("Destination metadata changed")
  })
})
