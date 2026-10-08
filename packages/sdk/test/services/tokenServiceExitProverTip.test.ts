/**
 * Wiring guard for the balance exits: a caller's prover tip reaches the burn the TEE batch declares
 * and the withdraw call the user's intent covers. Everything past batch building is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import type { OxideEnvTuple } from "@obsidion/core/types"

const f = vi.hoisted(() => ({
  withdraw: vi.fn((...args: unknown[]) => ({ with: () => ({ __fake: "withdrawCall", args }) })),
  authorize: vi.fn(async (..._args: unknown[]) => ({})),
  buildTee: vi.fn(async (..._args: any[]) => ({ batchCall: {}, sendOpts: {} })),
  buildSponsored: vi.fn(async (..._args: any[]) => ({
    payload: {},
    sendOpts: { additionalScopes: [], finalize: undefined, fee: undefined },
  })),
}))

vi.mock("@obsidion/contracts", async () => ({
  ...(await vi.importActual<typeof import("@obsidion/contracts")>("@obsidion/contracts")),
  getBroadcasterArtifact: async () => ({}),
  ensureContractRegisteredInPXE: async () => undefined,
  BroadcasterContract: { at: () => ({ methods: { broadcast_l1_operation_2k: () => ({}) } }) },
}))
vi.mock("../../src/services/teeOperation.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/services/teeOperation.js")>()),
  buildTeeOperation: f.buildTee,
}))
vi.mock("../../src/services/sponsoredTeeOperation.js", () => ({
  buildSponsoredTeeOperation: f.buildSponsored,
}))
vi.mock("../../src/services/claimSponsor.js", () => ({
  chainInfoFields: async () => ({ chainId: new Fr(31337n), version: new Fr(1n) }),
  registerSponsorFpc: async () => ({}),
  authorizeSponsoredBatch: f.authorize,
}))
// The intent hash follows the withdraw call's tip argument, so a tip the intent drops shows up.
vi.mock("@aztec/aztec.js/authorization", () => ({
  computeAuthWitMessageHash: async ({ action }: { action: { args: unknown[] } }) =>
    new Fr(1000n + (action.args[4] as bigint)),
}))

import { TokenService } from "../../src/services/TokenService.js"
import { ObsidionAccount } from "../../src/obsidion/alpha/account/ObsidionAccount.js"
import type { ClaimSponsorContext } from "../../src/services/claimSponsor.js"
import type { WithdrawalOptions } from "../../src/services/plainWithdrawal.js"

const token = AztecAddress.fromBigIntUnsafe(10n)
const user = AztecAddress.fromBigIntUnsafe(20n)
const recipient = EthAddress.fromString(`0x${"66".repeat(20)}`)
const tuple = {
  l2Token: token.toString(),
  portal: `0x${"11".repeat(20)}`,
  token: `0x${"33".repeat(20)}`,
  plainWithdrawalExecutor: `0x${"44".repeat(20)}`,
  l2Broadcaster: AztecAddress.fromBigIntUnsafe(11n).toString(),
} as OxideEnvTuple
const withdrawal: WithdrawalOptions = { tuple, portal: { fpcFundingCut: 7n, frozen: false } }
const AMOUNT = 1_000n * 10n ** 18n

function makeService() {
  const account = Object.assign(Object.create(ObsidionAccount.prototype) as ObsidionAccount, {
    getAddress: () => user,
    getAuthProvider: () => ({}),
    makeSpendMetadataResolver: async () => async () => ({}),
    makeDepositSpendMetadataResolver: async () => undefined,
  })
  const wallet = {
    pxe: {},
    node: {},
    sendTx: async () => ({ receipt: { txHash: { toString: () => "0xabc" }, blockNumber: 7 } }),
  }
  const service = Object.assign(Object.create(TokenService.prototype) as TokenService, {
    wallet,
    account,
    contractService: { getArtifactForInstance: async () => ({}) },
    ensureContractsRegistered: async () => undefined,
    emitInit: () => {},
    getTokenContract: async () => ({ address: token, methods: { withdraw: f.withdraw } }),
    getSendOptions: async () => ({}),
    formatAmount: async () => "1000",
    getTeeSigner: () => ({}),
    sendAndWait: async (init: () => Promise<unknown>) => init(),
  })
  return service
}

const sponsor = { fpcAddress: AztecAddress.fromBigIntUnsafe(55n) } as ClaimSponsorContext

const exitSelfPaid = (proverTip?: bigint) =>
  makeService().exitToL1Private(recipient, AMOUNT.toString(), {
    useRawAmount: true,
    withdrawal,
    resolveSpendMetadata: async () => ({} as never),
    ...(proverTip !== undefined ? { proverTip } : {}),
  })
const exitSponsored = (proverTip?: bigint) =>
  makeService().exitToL1PrivateSponsored(recipient, AMOUNT.toString(), sponsor, {
    useRawAmount: true,
    withdrawal,
    ...(proverTip !== undefined ? { proverTip } : {}),
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe.each([
  ["exitToL1Private", exitSelfPaid, () => f.buildTee.mock.lastCall![2]],
  ["exitToL1PrivateSponsored", exitSponsored, () => f.buildSponsored.mock.lastCall![1]],
])("TokenService.%s prover tip", (_name, exit, teeArgs) => {
  it("declares the caller's tip on the burn", async () => {
    await exit(3n)
    const [op] = teeArgs().operations
    expect(op).toMatchObject({ kind: "withdraw", amount: AMOUNT, proverTip: 3n })
  })

  it("defaults the tip to zero", async () => {
    await exit()
    expect(teeArgs().operations[0].proverTip).toBe(0n)
  })
})

it("the sponsored intent covers the tipped withdraw call", async () => {
  await exitSponsored(3n)
  expect(f.withdraw.mock.calls.every((args) => args[4] === 3n)).toBe(true)
  expect(f.withdraw).toHaveBeenCalled()
  const signed = (f.authorize.mock.lastCall![5] as Fr[]).map((h) => h.toBigInt())
  await exitSponsored(4n)
  const resigned = (f.authorize.mock.lastCall![5] as Fr[]).map((h) => h.toBigInt())
  expect(signed).toEqual([1003n])
  expect(resigned).toEqual([1004n])
})
