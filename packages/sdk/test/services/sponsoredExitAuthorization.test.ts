/**
 * One signature over several sponsored exits: what `authorizeSponsoredExits` signs and hands out,
 * and what an exit run under an authorization puts in its batch. Planning and intent hashing are
 * real; the batch builder and the send are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Contract } from "@aztec/aztec.js/contracts"
import { AztecAddress } from "@aztec/stdlib/aztec-address"

vi.mock("@obsidion/contracts", async (importActual) => ({
  ...(await importActual<typeof import("@obsidion/contracts")>()),
  ensureContractRegisteredInPXE: vi.fn(async () => undefined),
  BroadcasterContract: { at: () => ({ methods: { broadcast_l1_operation_2k: () => ({}) } }) },
}))

vi.mock("../../src/services/claimSponsor.js", () => ({
  chainInfoFields: vi.fn(async () => ({ chainId: new Fr(31337n), version: new Fr(1n) })),
  registerSponsorFpc: vi.fn(async () => ({})),
  buildAccountBatchCall: vi.fn(async () => "account-call"),
  authorizeSponsoredBatch: vi.fn(),
}))

vi.mock("../../src/services/sponsoredTeeOperation.js", () => ({
  buildSponsoredTeeOperation: vi.fn(async () => ({
    payload: {},
    sendOpts: { additionalScopes: [], finalize: {}, fee: {} },
  })),
}))

import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/contracts"
import { computeIntentsOnlyAuthWitHash } from "../../src/feePaymentMethod/sponsoredCall.js"
import { ObsidionAccount } from "../../src/obsidion/alpha/account/ObsidionAccount.js"
import { authorizeSponsoredBatch, chainInfoFields } from "../../src/services/claimSponsor.js"
import type { ClaimSponsorContext } from "../../src/services/claimSponsor.js"
import { buildSponsoredTeeOperation } from "../../src/services/sponsoredTeeOperation.js"
import { TokenService } from "../../src/services/TokenService.js"

const USER = AztecAddress.fromBigIntUnsafe(11n)
const TOKEN = AztecAddress.fromBigIntUnsafe(44n)
const sponsor = { fpcAddress: AztecAddress.fromBigIntUnsafe(55n) } as ClaimSponsorContext
const withdrawal = {
  tuple: {
    portal: EthAddress.fromNumber(0x11).toString(),
    token: EthAddress.fromNumber(0x22).toString(),
    l2Token: TOKEN.toString(),
    plainWithdrawalExecutor: EthAddress.fromNumber(0x33).toString(),
    l2Broadcaster: AztecAddress.fromBigIntUnsafe(66n).toString(),
  },
  portal: { fpcFundingCut: 0n, frozen: false },
}
const exits = [0xa1, 0xa2].map((recipient, i) => ({
  l1Recipient: EthAddress.fromNumber(recipient),
  amount: `${1_000 * (i + 1)}`,
  withdrawal,
}))

const createAuthWit = vi.fn(async () => "signature" as never)
const sendTx = vi.fn(async () => ({ receipt: { txHash: "0xabc", blockNumber: 7 } }))

async function makeService(): Promise<TokenService> {
  const account = Object.assign(Object.create(ObsidionAccount.prototype), {
    getAddress: () => USER,
    getAuthProvider: () => ({ createAuthWit }),
    makeSpendMetadataResolver: async () => undefined,
    makeDepositSpendMetadataResolver: async () => undefined,
  })
  const artifact = await getHardcodedArtifact(DEFAULT_CONTRACTS.oxideToken)
  const token = Contract.at(TOKEN, artifact, {} as never)
  return Object.assign(Object.create(TokenService.prototype), {
    account,
    wallet: { node: {}, sendTx },
    contractService: { getArtifactForInstance: async () => ({}) },
    getTokenContract: async () => token,
    formatAmount: async () => "",
    emitInit: () => undefined,
    _teeSigner: {},
  })
}

const exit = (service: TokenService, i: number, authorization: unknown) =>
  service.exitToL1PrivateSponsored(exits[i]!.l1Recipient, exits[i]!.amount, sponsor, {
    useRawAmount: true,
    withdrawal,
    authorization: authorization as never,
  })

describe("sponsored exits under one signature", () => {
  beforeEach(() => vi.clearAllMocks())

  it("signs once over every exit's intent and hands the signature to the first", async () => {
    const service = await makeService()
    const authorized = await service.authorizeSponsoredExits(exits, sponsor, { useRawAmount: true })
    const [gas, funds] = authorized

    expect(authorized).toHaveLength(2)
    expect(gas!.intentHashes).toHaveLength(2)
    expect(funds!.intentHashes).toEqual(gas!.intentHashes)
    const chain = await chainInfoFields({} as never)
    expect(createAuthWit.mock.calls).toEqual([
      [await computeIntentsOnlyAuthWitHash(USER, chain, gas!.intentHashes)],
    ])
    expect(gas!.authwitNonce).not.toEqual(funds!.authwitNonce)
    expect([gas!.combinedAuthWitness, funds!.combinedAuthWitness]).toEqual(["signature", undefined])
  })

  it.each([0, 1])("finds exit %i's intent at its place in the signed list", async (i) => {
    const service = await makeService()
    const authorized = await service.authorizeSponsoredExits(exits, sponsor, { useRawAmount: true })
    const under = (intent: number) => ({
      ...authorized[i]!,
      intentHashes: [authorized[i]!.intentHashes[intent]!],
    })

    await expect(exit(service, i, under(i))).resolves.toMatchObject({ txHash: "0xabc" })
    await expect(exit(service, i, under(1 - i))).rejects.toThrow(
      "this exit is not among the authorized intents",
    )
    expect(sendTx).toHaveBeenCalledTimes(1)
  })

  it("calls the account only from the exit that holds the signature, and signs nothing", async () => {
    const service = await makeService()
    const authorized = await service.authorizeSponsoredExits(exits, sponsor, { useRawAmount: true })
    createAuthWit.mockClear()
    await exit(service, 0, authorized[0])
    await exit(service, 1, authorized[1])

    const { intentHashes } = authorized[0]!
    const batches = vi.mocked(buildSponsoredTeeOperation).mock.calls.map(([, args]) => args)
    expect(
      batches.map((batch) => [batch.accountCall, batch.combinedAuthWitness, batch.intentHashes]),
    ).toEqual([
      ["account-call", "signature", intentHashes],
      [undefined, undefined, intentHashes],
    ])
    expect(createAuthWit).not.toHaveBeenCalled()
    expect(authorizeSponsoredBatch).not.toHaveBeenCalled()
  })
})
