/** A claim's deps over the open test session, with its chain reads and account service faked. */
import { vi } from "vitest"
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createRegistrationRecovery } from "@obsidion/front-core"
import type { ClaimDeps } from "../../src/features/onboarding/oxideOnboarding"
import { admissionFloor, refundedEntry } from "../../src/features/registration/admission"
import { makeRegistrationDepositSeeder } from "../../src/features/registration/registrationDepositSeed"
import type { Session } from "../../src/session/session"

export const OWNER = `0x${"11".repeat(20)}` as Address
export const OLD = `0x${"22".repeat(20)}` as Address
export const NEW = `0x${"33".repeat(20)}` as Address
export const TOKEN = `0x${"44".repeat(20)}` as Address
export const L2 = `0x${"55".repeat(32)}` as Hex
export const HASH = `0x${"66".repeat(32)}` as Hex
const IMPL = `0x${"77".repeat(20)}` as Address
const TABLE = `0x${"99".repeat(20)}` as Address
export const ENV = {
  registry: OWNER,
  factory: OWNER,
  ensDomain: "zk.money",
  resolverOperator: OWNER,
  rollupVersion: 1n,
  l1ChainId: 11155111,
  feeToken: TOKEN,
  namePortalRecipient: L2,
  entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address,
}
/** What the wallet's key derives for a new registration. */
export const DERIVATION = {
  sipaAddress: NEW,
  sipaArgs: {},
  recordData: "0x1234" as Hex,
  registrationData: "0x1234" as Hex,
  sharedSecretSalt: HASH,
  recipientCommitment: HASH,
  stealthScalar: 1n,
  origin: {
    protocol: "account",
    sipaFactory: OWNER,
    implementation: IMPL,
    intentHash: HASH,
    rollupVersion: "1",
    resweepable: false,
    recoveryAccount: OWNER,
    recoveryCommitment: HASH,
    accountFactory: OWNER,
    forwardingTable: TABLE,
  },
}
export const keys = {
  pubkeyHex: `0x${"11".repeat(64)}`,
  secretKey: new Fr(123n),
  account: { getAddress: () => ({ toString: () => L2 }), getAuthProvider: () => ({}) },
} as never

/** A refund receipt moving `amount` of the token off `from`. */
export const transfer = (amount: bigint, from: Address = OLD) => ({
  status: "success",
  logs: [
    {
      address: TOKEN,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from, to: OWNER },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    },
  ],
})

export function claimHarness(session: Session, tag = "demo") {
  const h = {
    sign: vi.fn(),
    registeredOwner: vi.fn(),
    heldName: vi.fn(),
    derive: vi.fn(),
    metadataRegistry: vi.fn(),
    balance: vi.fn(),
    receipt: vi.fn(),
    redeem: vi.fn(),
    withdrawalFee: vi.fn(),
  }
  const payloads = new Map()
  const recovery = createRegistrationRecovery({
    registrations: session.registrations,
    sipaDeposits: session.sipaDeposits,
    l1: () => ({ readContract: h.balance, getTransactionReceipt: h.receipt } as never),
    fundingTokens: async (fee) => [fee],
    decimalsOf: async () => 18,
    admissionFloor,
    entryFor: refundedEntry,
    heal: async () => 0,
  })
  const deps: ClaimDeps = {
    registrations: session.registrations,
    nameClaims: session.nameClaims,
    recovery,
    payloads,
    sessionDeps: async (onStage) => ({
      tag,
      env: ENV,
      masterSecret: new Fr(123n),
      l2Address: L2,
      accountService: { signDomain: h.sign },
      beneficiary: OWNER,
      scheduleFee: async () => 0n,
      l1: {
        predictAccountAddress: async () => OWNER,
        readUserAddress: h.registeredOwner,
        readNameOf: h.heldName,
        readAccountMetadataRegistry: h.metadataRegistry,
        readR1InstallGas: async () => ({
          verification: 50_000n,
          callBase: 85_000n,
          callPerWord: 30_000n,
        }),
        // The account has no code yet, so consent signs with the bootstrap key.
        getCode: async () => undefined,
      } as never,
      deriveRegistrationSipa: h.derive,
      turn: session.page.registrationTurn,
      seedSipaDeposit: makeRegistrationDepositSeeder(session.sipaDeposits, {
        feeToken: TOKEN,
        l1ChainId: ENV.l1ChainId,
        networkId: "0xnet",
      }),
      r1Key: { qx: HASH, qy: HASH },
      credentialId: "Y3JlZC1pZC0wMDE",
      registrations: session.registrations,
      onStage,
    }),
    redeemTicket: (onProving) => h.redeem(onProving),
    withdrawalFee: () => h.withdrawalFee(),
  }
  h.registeredOwner.mockResolvedValue(`0x${"00".repeat(20)}`)
  h.heldName.mockResolvedValue(`0x${"00".repeat(32)}`)
  h.metadataRegistry.mockResolvedValue(OWNER)
  h.balance.mockResolvedValue(0n)
  h.derive.mockResolvedValue(DERIVATION)
  h.redeem.mockResolvedValue("none")
  h.withdrawalFee.mockResolvedValue(0n)
  return { h, deps, payloads, recovery }
}
