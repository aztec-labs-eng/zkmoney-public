// The registration machine's collaborators, faked at their boundaries, over a real store.
import { vi } from "vitest"
import { type Address, type Hex, zeroAddress } from "viem"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord, loadRecords } from "../../src/engine/persistentStore"
import { createRegistrations, registrationAt } from "../../src/engine/registrations"
import type { PendingRegistrationRecord } from "../../src/engine/registrationRecord"
import { createSipaDeposits } from "../../src/engine/sipaDeposits"
import {
  encodeRegistrationData,
  encodeUserRecord,
  registrationCommitment,
} from "../../src/oxide/oxideRegistrationData"
import type {
  OxideRegistrationEnv,
  OxideSignDeps,
  RegistrationDepositReader,
  RegistrationDerivation,
} from "../../src/oxide/oxideRegistration"
import type { RegistrationIntent } from "@obsidion/core/types"

export const MSK = { toString: () => `0x${"ab".repeat(32)}` }
export const REGISTRY = "0x10ec7842a2c21f1c74ba180f4ee63fc0fc3ac8e5" as Address
export const AMR = "0x22ec7842a2c21f1c74ba180f4ee63fc0fc3ac8e5" as Address
export const OTHER_SIPA = "0x44ec7842a2c21f1c74ba180f4ee63fc0fc3ac8e5" as Address
export const FEE_TOKEN = "0x6504692a7e5535ba2786fe4575c2363f7e87b0a4" as Address
export const FACTORY = "0x00000000000000000000000000000000000000f0" as Address
export const RESOLVER = "0x00000000000000000000000000000000000000e0" as Address
export const OWNER = "0x00000000000000000000000000000000000000a1" as Address
export const SIPA = "0x00000000000000000000000000000000000000b2" as Address
export const BENEFICIARY = "0x00000000000000000000000000000000000000b5" as Address
export const L2 = `0x${"cd".repeat(32)}` as Hex
export const NO_NAME = `0x${"00".repeat(32)}` as Hex

export const RECORD: RegistrationIntent = {
  owner: OWNER,
  nameHash: `0x${"11".repeat(32)}`,
  record: {
    l2Address: L2,
    rollupVersion: 4127419662n,
    publicKey: { x: 5n, y: 7n },
    resolverOperator: RESOLVER,
  },
  fee: 1n,
  beneficiary: BENEFICIARY,
  recipientCommitment: `0x${"ef".repeat(32)}`,
  namePortalRecipient: `0x${"cd".repeat(32)}`,
}

export const RECORD_DATA = encodeUserRecord(RECORD.owner, RECORD.nameHash, RECORD.record)

export const ENV: OxideRegistrationEnv = {
  registry: REGISTRY,
  factory: FACTORY,
  ensDomain: "zk.money",
  resolverOperator: RESOLVER,
  rollupVersion: 4127419662n,
  l1ChainId: 31337,
  feeToken: FEE_TOKEN,
  namePortalRecipient: `0x${"cd".repeat(32)}`,
  entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address,
}

export const R1KEY = { qx: `0x${"a1".repeat(32)}` as Hex, qy: `0x${"a2".repeat(32)}` as Hex }
export const CREDENTIAL_ID = "Y3JlZC1pZC0wMDE"
/** A controller deployed before oxide raised the R1 install limits. */
export const EARLIER_R1_GAS = { verification: 50_000n, callBase: 85_000n, callPerWord: 30_000n }
export const USER_OP_HASH = `0x${"77".repeat(32)}` as Hex

export const DERIVATION: RegistrationDerivation = {
  sipaAddress: SIPA,
  sipaArgs: {
    implementation: zeroAddress,
    intentHash: registrationCommitment(RECORD),
    recoveryCommitment: `0x${"00".repeat(32)}`,
    rollupVersion: ENV.rollupVersion,
    resweepable: false,
  },
  origin: {
    protocol: "account",
    sipaFactory: zeroAddress,
    implementation: zeroAddress,
    intentHash: registrationCommitment(RECORD),
    recoveryCommitment: `0x${"00".repeat(32)}`,
    recoveryAccount: OWNER,
    accountFactory: ENV.factory,
    rollupVersion: String(ENV.rollupVersion),
    resweepable: false,
  },
  recipient: L2,
  sharedSecretSalt: `0x${"01".repeat(32)}`,
  recipientCommitment: `0x${"02".repeat(32)}`,
  registrationData: encodeRegistrationData(RECORD),
  recordData: RECORD_DATA,
  registration: registrationCommitment(RECORD),
  stealthScalar: 42n,
}

export const CLAIM = {
  signature: `0x${"cc".repeat(65)}` as Hex,
  nonce: "1",
  deadline: "9999999999",
}

/** A record as a session at SIPA writes it. */
export const recordAt = (
  over: Partial<PendingRegistrationRecord> = {},
): PendingRegistrationRecord => ({
  account: OWNER,
  tag: "alice",
  nameHash: RECORD.nameHash,
  l2Address: L2,
  l1ChainId: 31337,
  sipaAddress: SIPA,
  fee: "1",
  beneficiary: BENEFICIARY,
  depositToken: FEE_TOKEN,
  broadcast: true,
  phase: "awaiting_deposit",
  retries: 0,
  startTime: 0,
  ...over,
})

/** The account's registrations and deposits, holding `records` as saved. */
export function registrationStore(records: readonly PendingRegistrationRecord[] = []) {
  const backend = memoryBackend(
    new Map(
      records.map((r) => [`acct/registrations/${r.sipaAddress.toLowerCase()}`, encodeRecord(r)]),
    ),
  )
  const db = openDatabase(backend)
  const deposits = createSipaDeposits({ db, account: true })
  const registrations = createRegistrations({ db, legacy: db, deposits, account: true })
  const at = async (sipa: string) => registrationAt(await loadRecords(registrations.view), sipa)
  return { registrations, sipaDeposits: deposits, at }
}

const l1Reads = () => ({
  predictAccountAddress: vi.fn(async () => OWNER),
  readUserAddress: vi.fn(async () => zeroAddress as Address),
  readNameOf: vi.fn(async () => NO_NAME),
  readAccountMetadataRegistry: vi.fn(async () => AMR),
  readUserRecord: vi.fn(async () => ({ ...RECORD.record, l2Address: L2 })),
  getUserOpHash: vi.fn(async () => USER_OP_HASH),
  readR1InstallGas: vi.fn(async () => EARLIER_R1_GAS),
  getCode: vi.fn(async () => "0x"),
  readAuthKeys: vi.fn(async () => []),
})

export function sessionDeps(over: Partial<Record<string, unknown>> = {}) {
  const store = registrationStore()
  const signDomain = vi.fn(async () => CLAIM)
  const l1 = l1Reads()
  const deps = {
    tag: "alice",
    env: ENV,
    masterSecret: MSK,
    l2Address: L2,
    accountService: { signDomain },
    beneficiary: BENEFICIARY,
    scheduleFee: async () => 1n,
    r1Key: R1KEY,
    credentialId: CREDENTIAL_ID,
    l1,
    deriveRegistrationSipa: vi.fn(async () => DERIVATION),
    registrations: store.registrations,
    ...over,
  }
  return { deps: deps as never, ...store, signDomain, l1 }
}

export function resumeDeps(
  record: Partial<PendingRegistrationRecord>,
  over: Partial<Record<string, unknown>> = {},
  others: readonly PendingRegistrationRecord[] = [],
) {
  const full = recordAt(record)
  const store = registrationStore([full, ...others])
  const deposits = {
    readFunding: vi.fn<RegistrationDepositReader["readFunding"]>(async () => []),
    readBalance: vi.fn<RegistrationDepositReader["readBalance"]>(async () => 0n),
    readSweeps: vi.fn<RegistrationDepositReader["readSweeps"]>(async () => []),
    floor: vi.fn<RegistrationDepositReader["floor"]>(async () => 10n),
    scheduleFee: vi.fn<RegistrationDepositReader["scheduleFee"]>(async () => 1n),
  } satisfies RegistrationDepositReader
  const l1 = l1Reads()
  const deps = {
    env: ENV,
    l1,
    deposits,
    registrations: store.registrations,
    close: async (r: PendingRegistrationRecord, event: never) =>
      void (await store.registrations.apply(r.sipaAddress, event)),
    ...over,
  }
  return { deps: deps as never, ...store, record: full, deposits, l1 }
}

/** The unlocked wallet's sign deps, over a claim server the test can steer. */
export function signDeps(signDomain = vi.fn(async (): Promise<unknown> => CLAIM)) {
  return {
    masterSecret: MSK,
    accountService: { signDomain },
    r1Key: R1KEY,
    credentialId: CREDENTIAL_ID,
    l1: {
      readAccountMetadataRegistry: vi.fn(async () => AMR),
      getUserOpHash: vi.fn(async () => USER_OP_HASH),
      readR1InstallGas: vi.fn(async () => EARLIER_R1_GAS),
      getCode: vi.fn(async () => "0x"),
      readAuthKeys: vi.fn(async () => []),
    },
    deriveRegistrationSipa: vi.fn(async () => DERIVATION),
  } as never as OxideSignDeps & { accountService: { signDomain: typeof signDomain } }
}
