import { beforeEach, describe, expect, it, vi } from "vitest"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  DEFAULT_CONTRACTS,
  PROOF_FIELD_COUNT,
  VKEY_FIELD_COUNT,
  ZKJWT_PUBLIC_INPUT_COUNT,
} from "@obsidion/core/constants"

const INSTANCE_ADDR = AztecAddress.fromBigIntUnsafe(33n)
const TOKEN_ADDR = AztecAddress.fromBigIntUnsafe(44n)

const { instance, claimToL1Spy, buildSponsoredTeeOperation } = vi.hoisted(() => ({
  instance: {
    address: null as unknown as AztecAddress,
    initializationHash: {},
    currentContractClassId: { equals: () => true },
    publicKeys: {},
  },
  claimToL1Spy: vi.fn(() => ({ __fake: "claimToL1" })),
  buildSponsoredTeeOperation: vi.fn(async () => ({
    payload: {},
    sendOpts: { additionalScopes: [] },
  })),
}))
instance.address = INSTANCE_ADDR

vi.mock("@obsidion/contracts", async (importActual) => ({
  ...(await importActual<typeof import("@obsidion/contracts")>()),
  ensureContractRegisteredInPXE: vi.fn(async () => undefined),
  BroadcasterContract: {
    at: vi.fn(() => ({ methods: { broadcast_l1_operation_2k: vi.fn(() => ({})) } })),
  },
}))
vi.mock("@aztec/stdlib/contract", async (importActual) => ({
  ...(await importActual<typeof import("@aztec/stdlib/contract")>()),
  getContractInstanceFromInstantiationParams: async () => instance,
}))
vi.mock("@aztec/aztec.js/contracts", async (importActual) => {
  const actual = await importActual<typeof import("@aztec/aztec.js/contracts")>()
  return {
    ...actual,
    Contract: {
      ...(actual.Contract as object),
      at: () => ({
        address: INSTANCE_ADDR,
        methods: {
          claim_to_l1: claimToL1Spy,
          // A 1-token escrow note: `data` packs the amount in its top 16 bytes.
          sync_note: () => ({
            simulate: async () => ({
              result: {
                data: new Fr((10n ** 18n) << 128n),
                refundable_until: Fr.ZERO,
                token_address: TOKEN_ADDR,
              },
            }),
          }),
        },
      }),
    },
  }
})
vi.mock("../../../src/services/claimSponsor.js", () => ({
  chainInfoFields: async () => ({ chainId: new Fr(31337n), version: new Fr(1n) }),
  linkChainInfo: async () => ({ chainId: 31337, rollupVersion: 1 }),
  registerSponsorFpc: async () => ({}),
  contractClassWitness: async () => ({}),
  authorizeSponsoredBatch: async () => ({ intentHashes: [] }),
}))
vi.mock("../../../src/services/sponsoredTeeOperation.js", () => ({ buildSponsoredTeeOperation }))
vi.mock("../../../src/services/paylink/paylinkKeys.js", () => ({
  derivePaylinkKeys: async () => ({ publicKeys: {}, secretKey: {} }),
  registerPaylinkContractWithKeys: vi.fn(),
  registerEscrowTagSecret: vi.fn(),
}))
vi.mock("../../../src/services/paylink/paylinkRecovery.js", () => ({
  findEscrowDepositTx: async () => undefined,
}))
vi.mock("../../../src/services/paylink/paylinkSpendMetadata.js", () => ({
  makePaylinkSpendMetadataResolver: vi.fn(),
}))

import { PaylinkService, type PaylinkParams } from "../../../src/services/PaylinkService.js"
import { ObsidionAccount } from "../../../src/obsidion/alpha/account/ObsidionAccount.js"
import {
  exitPaylinkWithVoucher,
  type PaylinkExitArgs,
} from "../../../src/services/paylink/paylinkVoucher.js"
import type { ClaimSponsorContext } from "../../../src/services/claimSponsor.js"
import type { WithdrawalOptions } from "../../../src/services/plainWithdrawal.js"

const recipient = EthAddress.fromString("0x2222222222222222222222222222222222222222")
const withdrawal: WithdrawalOptions = {
  tuple: {
    portal: `0x${"11".repeat(20)}`,
    token: `0x${"22".repeat(20)}`,
    l2Token: TOKEN_ADDR.toString(),
    plainWithdrawalExecutor: `0x${"33".repeat(20)}`,
    l2Broadcaster: AztecAddress.fromBigIntUnsafe(66n).toString(),
  },
  portal: { fpcFundingCut: 0n, frozen: false },
}
const proof = {
  vkey: Array(VKEY_FIELD_COUNT).fill("0x01"),
  proof: Array(PROOF_FIELD_COUNT).fill("0x02"),
  public_inputs: Array(ZKJWT_PUBLIC_INPUT_COUNT).fill("0x01"),
}
const params = {
  paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
  classId: Fr.ZERO,
  chainId: 31337,
  rollupVersion: 1,
} as PaylinkParams
const sponsor = {} as ClaimSponsorContext
const sendTx = vi.fn()
const wallet = { node: {}, pxe: {}, sendTx, registerSender: vi.fn() } as any
const contractService = {
  getArtifactForContract: vi.fn(async () => ({})),
  getArtifactForInstance: vi.fn(async () => ({})),
} as any

function makeService() {
  const account = Object.assign(Object.create(ObsidionAccount.prototype) as ObsidionAccount, {
    getAddress: () => AztecAddress.fromBigIntUnsafe(11n),
  })
  const tokenService = { getTokenContract: async () => ({ address: TOKEN_ADDR }) } as any
  const service = new PaylinkService(wallet, account, tokenService, contractService)
  Object.assign(service as any, {
    reconstructPaylinkContract: async () => ({ instance, keys: {} }),
    payoutMeta: async () => [],
  })
  return service
}

const claimSponsored = (l1Recipient: EthAddress, zkProof?: typeof proof) =>
  makeService().claimSponsoredPaylinkToL1(
    params,
    l1Recipient,
    { proverTip: 0n, withdrawal, zkProof },
    sponsor,
  )
const voucher = (l1Recipient: EthAddress, zkProof?: typeof proof) =>
  exitPaylinkWithVoucher({
    params,
    wallet,
    contractService,
    sponsor,
    tokenAddress: TOKEN_ADDR,
    l1Recipient,
    withdrawal,
    zkProof,
  } as PaylinkExitArgs)

describe("both public L1 claim APIs reject invalid inputs before submission", () => {
  beforeEach(() => vi.clearAllMocks())

  const expectNothingBuilt = () => {
    expect(claimToL1Spy).not.toHaveBeenCalled()
    expect(buildSponsoredTeeOperation).not.toHaveBeenCalled()
    expect(sendTx).not.toHaveBeenCalled()
  }

  it("requires an email proof", async () => {
    await expect(claimSponsored(recipient)).rejects.toThrow(/zkProof/)
    await expect(voucher(recipient)).rejects.toThrow(/zkProof/)
    expectNothingBuilt()
  })

  it("rejects a proof bound to the recipient rather than the payout", async () => {
    const zkProof = {
      ...proof,
      public_inputs: [recipient.toField().toString(), ...proof.public_inputs.slice(1)],
    }
    await expect(claimSponsored(recipient, zkProof)).rejects.toThrow(
      /not bound to the withdrawal payout/,
    )
    await expect(voucher(recipient, zkProof)).rejects.toThrow(/not bound to the withdrawal payout/)
    expectNothingBuilt()
  })

  it("rejects zero destinations", async () => {
    await expect(claimSponsored(EthAddress.ZERO, proof)).rejects.toThrow(
      /recipient must not be zero/,
    )
    await expect(voucher(EthAddress.ZERO, proof)).rejects.toThrow(/recipient must not be zero/)
    expectNothingBuilt()
  })
})
