// @vitest-environment node
/**
 * Deposit-gated registration machine (registration-fee.md) + the D2 registration-SIPA payload
 * encoding. Every collaborator is injected, so the full session/detection sequence runs without
 * HTTP / RPC / real passkeys.
 */

import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, type Hex, getAddress, keccak256, recoverAddress, zeroAddress } from "viem"
import { decodeRegistrationIntentData } from "@oxide/l1-contracts"

import {
  encodeRegistrationData,
  encodeUserRecord,
  registrationCommitment,
  consentDigest,
} from "../../src/oxide/oxideRegistrationData"
import { deriveBootstrapKey } from "../../src/oxide/oxideAccountKeys"
import { AccountServiceError } from "../../src/oxide/accountServiceClient"
import {
  startOxideRegistrationSession,
  type RegistrationBroadcastPayload,
  resumeOxideRegistration,
  AWAITING_SWEEP_WINDOW_MS,
  BROADCAST_IN_FLIGHT_MS,
  type OxideRegistrationEnv,
  type PendingRegistrationStoreLike,
  type RegistrationDerivation,
  type RegistrationDepositReader,
} from "../../src/oxide/oxideRegistration"
import type {
  PendingRegistrationPhase,
  PendingRegistrationRecord,
} from "../../src/core/services/registration"
import type { RegistrationIntent } from "@obsidion/core/types"

const MSK = { toString: () => `0x${"ab".repeat(32)}` }
const REGISTRY = "0x10ec7842a2c21f1c74ba180f4ee63fc0fc3ac8e5" as Address
const AMR = "0x22ec7842a2c21f1c74ba180f4ee63fc0fc3ac8e5" as Address
const OTHER_SIPA = "0x44ec7842a2c21f1c74ba180f4ee63fc0fc3ac8e5" as Address
const FEE_TOKEN = "0x6504692a7e5535ba2786fe4575c2363f7e87b0a4" as Address
const FACTORY = "0x00000000000000000000000000000000000000f0" as Address
const RESOLVER = "0x00000000000000000000000000000000000000e0" as Address
const OWNER = "0x00000000000000000000000000000000000000a1" as Address
const SIPA = "0x00000000000000000000000000000000000000b2" as Address
const BENEFICIARY = "0x00000000000000000000000000000000000000b5" as Address
const L2 = `0x${"cd".repeat(32)}` as Hex
const NO_NAME = `0x${"00".repeat(32)}` as Hex

const RECORD: RegistrationIntent = {
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

const RECORD_DATA = encodeUserRecord(RECORD.owner, RECORD.nameHash, RECORD.record)

const ENV: OxideRegistrationEnv = {
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

const R1KEY = { qx: `0x${"a1".repeat(32)}` as Hex, qy: `0x${"a2".repeat(32)}` as Hex }
const CREDENTIAL_ID = "Y3JlZC1pZC0wMDE"
const USER_OP_HASH = `0x${"77".repeat(32)}` as Hex

// ── D2: payload encoding + consent ────────────────────────────────────────────

describe("registrationData encoding", () => {
  it("wraps the identity record with the routing and commits to their keccak256", () => {
    const data = encodeRegistrationData(RECORD)
    // recordData is `owner` + `nameHash` + the 5 static UserRecord words (publicKey is two) => 7.
    expect(RECORD_DATA).toHaveLength(2 + 2 * 32 * 7)
    // The intent is (bytes recordData, uint256 fee, address beneficiary, bytes32 recipient,
    // bytes32 namePortalRecipient): 5 head words + a length word + payload.
    expect(data).toHaveLength(2 + 2 * (32 * 6 + 32 * 7))
    expect(registrationCommitment(RECORD)).toBe(keccak256(data))
  })

  it("round-trips through the contract's own decoder", () => {
    // The sweep decodes with these bytes; a client-side encoding that drifts from oxide's derives a
    // SIPA no relayer can sweep, so pin the codec against the decoder rather than a literal. The
    // decoder returns checksummed addresses.
    expect(decodeRegistrationIntentData(encodeRegistrationData(RECORD))).toEqual({
      ...RECORD,
      owner: getAddress(OWNER),
      record: { ...RECORD.record, resolverOperator: getAddress(RESOLVER) },
    })
  })

  it("changing the fee or the beneficiary changes the commitment (a different SIPA address)", () => {
    expect(registrationCommitment({ ...RECORD, fee: 2n })).not.toBe(registrationCommitment(RECORD))
    expect(registrationCommitment({ ...RECORD, beneficiary: OWNER })).not.toBe(
      registrationCommitment(RECORD),
    )
  })

  it("consentDigest binds the chain, the AccountMetadataRegistry and the settling SIPA", () => {
    const base = consentDigest(RECORD_DATA, 31337, AMR, SIPA)
    expect(consentDigest(RECORD_DATA, 31338, AMR, SIPA)).not.toBe(base)
    expect(consentDigest(RECORD_DATA, 31337, REGISTRY, SIPA)).not.toBe(base)
    // A second blessed clone carrying the same intent hash cannot spend this consent: the
    // controller recovers a different signer and rejects it.
    expect(consentDigest(RECORD_DATA, 31337, AMR, OTHER_SIPA)).not.toBe(base)
  })

  // A digest the controller does not recover over is unrecoverable at the worst moment: the sweep
  // reverts with the deposit already paid, and nothing before it can tell. Neither side is typed
  // against the other, so pin the preimage against the vendored Solidity itself.
  it("matches the preimage RegistrationController._consentDigest hashes at the oxide pin", () => {
    const solidity = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../vendor/oxide/l1-contracts/src/periphery/RegistrationController.sol",
      ),
      "utf8",
    )
    const body =
      /function _consentDigest\(([^)]*)\)[\s\S]*?abi\.encode\(([^)]*\)?[^)]*)\)\s*\)/.exec(solidity)
    expect(body, "_consentDigest not found in the vendored RegistrationController").not.toBeNull()
    const args = body![2].split(",").map((a) => a.trim())
    expect(args).toEqual([
      "recordData",
      "block.chainid",
      "NAME_REGISTRY.accountMetadataRegistry()",
      "sipa",
    ])
  })
})

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeStore implements PendingRegistrationStoreLike {
  records = new Map<string, PendingRegistrationRecord>()
  current(): PendingRegistrationRecord | null {
    for (const r of this.records.values()) {
      if (r.phase !== "confirmed" && r.phase !== "failed_taken" && r.phase !== "failed_terminal")
        return r
    }
    return null
  }
  get(account: string): PendingRegistrationRecord | null {
    return this.records.get(account.toLowerCase()) ?? null
  }
  async upsert(
    account: string,
    patch: Partial<PendingRegistrationRecord>,
    fallback?: Omit<PendingRegistrationRecord, "account">,
  ): Promise<PendingRegistrationRecord> {
    const key = account.toLowerCase()
    const existing = this.records.get(key)
    const next = existing
      ? { ...existing, ...patch, account }
      : ({ ...(fallback as object), ...patch, account } as PendingRegistrationRecord)
    this.records.set(key, next)
    return next
  }
  async close(
    account: string,
    phase: PendingRegistrationPhase,
  ): Promise<PendingRegistrationRecord> {
    return this.upsert(account, { phase })
  }
  async remove(account: string): Promise<void> {
    this.records.delete(account.toLowerCase())
  }
}

const DERIVATION: RegistrationDerivation = {
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

const CLAIM = { signature: `0x${"cc".repeat(65)}` as Hex, nonce: "1", deadline: "9999999999" }

function sessionDeps(over: Partial<Record<string, unknown>> = {}) {
  const store = new FakeStore()
  const broadcast = vi.fn(async () => {})
  const signDomain = vi.fn(async () => CLAIM)
  const l1 = {
    predictAccountAddress: vi.fn(async () => OWNER),
    readUserAddress: vi.fn(async () => zeroAddress as Address),
    readNameOf: vi.fn(async () => NO_NAME),
    readAccountMetadataRegistry: vi.fn(async () => AMR),
    readUserRecord: vi.fn(async () => ({ ...RECORD.record, l2Address: L2 })),
    getUserOpHash: vi.fn(async () => USER_OP_HASH),
    getCode: vi.fn(async () => "0x"),
    readAuthKeys: vi.fn(async () => []),
  }
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
    broadcast,
    pendingStore: store,
    now: () => 1_000,
    ...over,
  }
  return { deps: deps as never, store, broadcast, signDomain, l1 }
}

// ── Session ─────────────────────────────────────────────────────────────────

describe("startOxideRegistrationSession", () => {
  it("short-circuits when the name is already registered to our account", async () => {
    const { deps, l1 } = sessionDeps()
    l1.readUserAddress.mockResolvedValue(OWNER)
    const out = await startOxideRegistrationSession(deps)
    expect(out.status).toBe("registered")
  })

  it("reports taken when the name resolves to another account", async () => {
    const { deps, l1 } = sessionDeps()
    l1.readUserAddress.mockResolvedValue("0x00000000000000000000000000000000000000ff" as Address)
    const out = await startOxideRegistrationSession(deps)
    expect(out).toMatchObject({ status: "taken", reason: "registered" })
  })

  it("adopts a different name the account already holds when the record still points at our L2", async () => {
    const held = `0x${"99".repeat(32)}` as Hex
    const { deps, l1 } = sessionDeps({ resolveLocalTag: async () => "bob" })
    l1.readNameOf.mockResolvedValue(held)
    const out = await startOxideRegistrationSession(deps)
    expect(out).toMatchObject({
      status: "already_registered",
      name: "bob.zk.money",
      nameHash: held,
    })
    expect(l1.readUserRecord).toHaveBeenCalledWith(AMR, OWNER)
  })

  it("will not adopt a held name whose metadata record is absent", async () => {
    const { deps, l1 } = sessionDeps({ resolveLocalTag: async () => "bob" })
    l1.readNameOf.mockResolvedValue(`0x${"99".repeat(32)}` as Hex)
    l1.readUserRecord.mockResolvedValue(null as never)
    const out = await startOxideRegistrationSession(deps)
    expect(out).toMatchObject({ status: "already_registered", name: null })
  })

  it("a new address after refund does not inherit the old deposit's custody bookmarks", async () => {
    const { deps, store } = sessionDeps()
    await startOxideRegistrationSession(deps)
    await store.upsert(OWNER, {
      sipaAddress: OTHER_SIPA,
      fundedAt: 1,
      fundingTxHash: CLAIM.signature,
      sweptAt: 2,
      sweepTxHash: CLAIM.signature,
      nextAttemptAt: 999999,
      endTime: 3,
    })
    const result = await startOxideRegistrationSession(deps)
    expect(result.status).toBe("awaiting_deposit")
    const record = store.get(OWNER)!
    expect(record.sipaAddress).toBe(SIPA)
    for (const field of [
      "fundedAt",
      "fundingTxHash",
      "sweptAt",
      "sweepTxHash",
      "nextAttemptAt",
      "endTime",
    ] as const) {
      expect(record[field]).toBeUndefined()
    }
  })

  it("checkpoints the refund entry with the replacement, before the consent read", async () => {
    const entry = { sipaAddress: OTHER_SIPA, recoveryTxHash: CLAIM.signature, amount: "5" }
    const { deps, store, l1 } = sessionDeps({ refundedEntry: entry })
    l1.readAccountMetadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(startOxideRegistrationSession(deps)).rejects.toThrow("rpc down")
    expect(store.get(OWNER)).toMatchObject({ sipaAddress: SIPA, refundedEntry: entry })
  })

  it("checkpoints the replaced address with the replacement, before the consent read", async () => {
    const replaced = { sipaAddress: OTHER_SIPA, refunded: false, broadcastSpent: true }
    const onCheckpoint = vi.fn(async () => {})
    const { deps, store, l1 } = sessionDeps({ replaced, onCheckpoint })
    l1.readAccountMetadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(startOxideRegistrationSession(deps)).rejects.toThrow("rpc down")
    expect(store.get(OWNER)).toMatchObject({ sipaAddress: SIPA, replaced })
    expect(onCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: SIPA, replaced }),
    )
  })

  it("does not broadcast when the replaced address spent the account's one-shot rail", async () => {
    const replaced = { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true }
    const { deps, store, broadcast } = sessionDeps({ replaced, deferBroadcast: true })
    const out = await startOxideRegistrationSession(deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    expect(out.broadcastDone).toBeUndefined()
    expect(broadcast).not.toHaveBeenCalled()
    expect(store.get(OWNER)).toMatchObject({ sipaAddress: SIPA, broadcast: false, replaced })
  })

  it("derives the SIPA, claims, broadcasts, and returns the deposit address", async () => {
    const { deps, store, broadcast, signDomain } = sessionDeps()
    const out = await startOxideRegistrationSession(deps)
    expect(out.status).toBe("awaiting_deposit")
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    expect(out.sipaAddress).toBe(SIPA)
    expect(out.depositToken).toBe(FEE_TOKEN)
    expect(out.payload.registrationData).toBe(DERIVATION.registrationData)
    expect(out.payload.consentSig).toMatch(/^0x[0-9a-f]+$/)
    expect(out.payload.r1Install.qx).toBe(R1KEY.qx)
    expect(out.payload.r1Install.qy).toBe(R1KEY.qy)
    expect(out.payload.r1Install.signature).toMatch(/^0x[0-9a-f]+$/)
    expect(signDomain).toHaveBeenCalledWith({ nameHash: expect.any(String), userAddress: OWNER })
    expect(broadcast).toHaveBeenCalledOnce()
    const rec = store.get(OWNER)!
    expect(rec.phase).toBe("awaiting_deposit")
    expect(rec.sipaAddress).toBe(SIPA)
    expect(rec.fee).toBe("1")
    expect(rec.beneficiary).toBe(BENEFICIARY)
    expect(rec.broadcast).toBe(true)
  })

  it("deferred: returns the address before the broadcast lands, then stamps the record", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { deps, store } = sessionDeps({
      deferBroadcast: true,
      broadcast: vi.fn(() => gate),
    })
    const out = await startOxideRegistrationSession(deps)
    expect(out.status).toBe("awaiting_deposit")
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    void out.startBroadcast!()
    // Returned while the broadcast is still in flight: the record says so.
    expect(store.get(OWNER)!.broadcast).toBe(false)
    release()
    expect(await out.broadcastDone).toBe(true)
    expect(store.get(OWNER)!.broadcast).toBe(true)
  })

  it("deferred: a broadcast landing after the account moved on marks the replacement spent, not broadcast", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { deps, store } = sessionDeps({
      deferBroadcast: true,
      broadcast: vi.fn(() => gate),
    })
    const out = await startOxideRegistrationSession(deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    void out.startBroadcast!()
    // The earned quote replaced the address while the first broadcast was still proving.
    await store.upsert(OWNER, {
      sipaAddress: OTHER_SIPA,
      broadcast: false,
      replaced: { sipaAddress: SIPA, refunded: false, broadcastSpent: false },
    })
    release()
    expect(await out.broadcastDone).toBe(true)
    expect(store.get(OWNER)).toMatchObject({
      sipaAddress: OTHER_SIPA,
      broadcast: false,
      replaced: { sipaAddress: SIPA, refunded: false, broadcastSpent: true },
    })
  })

  it("deferred: a failed broadcast resolves broadcastDone false and leaves the record resumable", async () => {
    const { deps, store } = sessionDeps({
      deferBroadcast: true,
      broadcast: vi.fn(async () => {
        throw new Error("proving died")
      }),
    })
    const out = await startOxideRegistrationSession(deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    void out.startBroadcast!()
    expect(await out.broadcastDone).toBe(false)
    expect(store.get(OWNER)!.broadcast).toBe(false)
    expect(store.get(OWNER)!.broadcastStartedAt).toBeUndefined()
  })

  it("deferred: proves nothing until startBroadcast, and stamps the record while it runs", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const broadcast = vi.fn(() => gate)
    const { deps, store } = sessionDeps({ deferBroadcast: true, broadcast })
    const out = await startOxideRegistrationSession(deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    await new Promise((r) => setTimeout(r, 0))
    expect(broadcast).not.toHaveBeenCalled()
    expect(store.get(OWNER)!.broadcastStartedAt).toBeUndefined()
    const first = out.startBroadcast!()
    expect(out.startBroadcast!()).toBe(first)
    await new Promise((r) => setTimeout(r, 0))
    expect(broadcast).toHaveBeenCalledOnce()
    expect(store.get(OWNER)!.broadcastStartedAt).toEqual(expect.any(Number))
    release()
    expect(await out.broadcastDone).toBe(true)
    expect(store.get(OWNER)).toMatchObject({ broadcast: true })
    expect(store.get(OWNER)!.broadcastStartedAt).toBeUndefined()
  })

  it("drops the record and reports taken when the claim server refuses a reserved name", async () => {
    const { deps, store, signDomain } = sessionDeps()
    signDomain.mockRejectedValue(
      new AccountServiceError(409, "reserved", { reason: "name_reserved" }),
    )
    const out = await startOxideRegistrationSession(deps)
    // The refusals lead different places, so which one it was survives the outcome.
    expect(out).toMatchObject({ status: "taken", reason: "reserved" })
    expect(store.get(OWNER)).toBeNull()
  })

  it("distinguishes a blocked name from a reserved one", async () => {
    const { deps, signDomain } = sessionDeps()
    signDomain.mockRejectedValue(
      new AccountServiceError(403, "blocked", { reason: "name_blocked" }),
    )
    expect(await startOxideRegistrationSession(deps)).toMatchObject({
      status: "taken",
      reason: "blocked",
    })
  })
})

// ── Detection ───────────────────────────────────────────────────────────────

function resumeDeps(
  record: Partial<PendingRegistrationRecord>,
  over: Partial<Record<string, unknown>> = {},
) {
  const store = new FakeStore()
  const full: PendingRegistrationRecord = {
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
    ...record,
  }
  store.records.set(OWNER.toLowerCase(), full)
  const deposits: RegistrationDepositReader = {
    readFunding: vi.fn(async () => []),
    readBalance: vi.fn(async () => 0n),
    readSweeps: vi.fn(async () => []),
    floor: vi.fn(async () => 10n),
    scheduleFee: vi.fn(async () => 1n),
  }
  const l1 = {
    predictAccountAddress: vi.fn(async () => OWNER),
    readUserAddress: vi.fn(async () => zeroAddress as Address),
    readNameOf: vi.fn(async () => NO_NAME),
    readAccountMetadataRegistry: vi.fn(async () => AMR),
    readUserRecord: vi.fn(async () => ({ ...RECORD.record, l2Address: L2 })),
    getUserOpHash: vi.fn(async () => USER_OP_HASH),
    getCode: vi.fn(async () => "0x"),
    readAuthKeys: vi.fn(async () => []),
  }
  const deps = { env: ENV, l1, deposits, pendingStore: store, now: () => 5_000, ...over }
  return { deps: deps as never, store, deposits, l1 }
}

/** The lazily-loaded sign deps a re-broadcast cycle needs, over an injected broadcaster. */
function signDepsWith(broadcast: ReturnType<typeof vi.fn>) {
  return async () => ({
    masterSecret: MSK,
    accountService: { signDomain: vi.fn(async () => CLAIM) },
    r1Key: R1KEY,
    credentialId: CREDENTIAL_ID,
    l1: {
      readAccountMetadataRegistry: vi.fn(async () => AMR),
      getUserOpHash: vi.fn(async () => USER_OP_HASH),
      getCode: vi.fn(async () => "0x"),
      readAuthKeys: vi.fn(async () => []),
    },
    deriveRegistrationSipa: vi.fn(async () => DERIVATION),
    broadcast,
  })
}

describe("resumeOxideRegistration", () => {
  it("resumes the selected registration even when another record is current", async () => {
    const { deps, store, l1 } = resumeDeps({})
    const other = { ...store.get(OWNER)!, account: FACTORY, tag: "bob", nameHash: NO_NAME }
    store.records.set(FACTORY.toLowerCase(), other)
    vi.spyOn(store, "current").mockReturnValue(other)
    l1.readUserAddress.mockResolvedValue(OWNER)
    expect(
      await resumeOxideRegistration(deps, {
        expectedRecord: { account: OWNER, nameHash: RECORD.nameHash },
      }),
    ).toBe("confirmed")
    expect(store.get(OWNER)?.phase).toBe("confirmed")
    expect(store.get(FACTORY)?.phase).toBe("awaiting_deposit")
    expect(l1.readUserAddress).toHaveBeenCalledWith(REGISTRY, RECORD.nameHash)
  })

  it("does not fall back to the current registration when the selected one is absent", async () => {
    const { deps, store, l1 } = resumeDeps({})
    expect(
      await resumeOxideRegistration(deps, {
        expectedRecord: { account: FACTORY, nameHash: RECORD.nameHash },
      }),
    ).toBe("pending")
    expect(l1.readUserAddress).not.toHaveBeenCalled()
    expect(store.get(OWNER)?.phase).toBe("awaiting_deposit")
  })

  it("does not resume a selected record whose name changed while the tick was queued", async () => {
    const { deps, store, l1 } = resumeDeps({})
    expect(
      await resumeOxideRegistration(deps, {
        expectedRecord: { account: OWNER, nameHash: NO_NAME },
      }),
    ).toBe("pending")
    expect(l1.readUserAddress).not.toHaveBeenCalled()
    expect(store.get(OWNER)?.phase).toBe("awaiting_deposit")
  })

  it("leaves a terminal selected record closed", async () => {
    const { deps, store, l1 } = resumeDeps({ phase: "failed_terminal" })
    expect(
      await resumeOxideRegistration(deps, {
        expectedRecord: { account: OWNER, nameHash: RECORD.nameHash },
      }),
    ).toBe("idle")
    expect(l1.readUserAddress).not.toHaveBeenCalled()
    expect(store.get(OWNER)?.phase).toBe("failed_terminal")
  })

  it("confirms when the Registry resolves the name to our account", async () => {
    const { deps, store, l1 } = resumeDeps({})
    l1.readUserAddress.mockResolvedValue(OWNER)
    expect(await resumeOxideRegistration(deps)).toBe("confirmed")
    expect(store.get(OWNER)!.phase).toBe("confirmed")
  })

  it("reports taken when the name resolves to another account", async () => {
    const { deps, store, l1 } = resumeDeps({})
    l1.readUserAddress.mockResolvedValue("0x00000000000000000000000000000000000000ff" as Address)
    expect(await resumeOxideRegistration(deps)).toBe("taken")
    expect(store.get(OWNER)!.phase).toBe("failed_taken")
  })

  it("marks the record funded when a deposit at/above the floor lands", async () => {
    const { deps, store, deposits } = resumeDeps({})
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(50n)
    ;(deposits.readFunding as ReturnType<typeof vi.fn>).mockResolvedValue([
      { amount: 50n, txHash: `0x${"ee".repeat(32)}` },
    ])
    const out = await resumeOxideRegistration(deps)
    expect(out).toBe("pending")
    const rec = store.get(OWNER)!
    expect(rec.phase).toBe("funded")
    expect(rec.fundedAt).toBeDefined()
    expect(rec.fundingTxHash).toBe(`0x${"ee".repeat(32)}`)
  })

  it("reads funding off the balance, not the sum of transfers a refund left behind", async () => {
    const { deps, store, deposits } = resumeDeps({})
    // 13 in, refunded, 2 in: the transfers still sum past the floor of 10.
    ;(deposits.readFunding as ReturnType<typeof vi.fn>).mockResolvedValue([
      { amount: 13n, txHash: `0x${"ee".repeat(32)}` },
      { amount: 2n, txHash: `0x${"ef".repeat(32)}` },
    ])
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(2n)
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(store.get(OWNER)!.phase).toBe("awaiting_deposit")
    expect(store.get(OWNER)!.fundedAt).toBeUndefined()
  })

  it("decides nothing about funding when the balance cannot be read", async () => {
    const { deps, store, deposits } = resumeDeps({})
    ;(deposits.readFunding as ReturnType<typeof vi.fn>).mockResolvedValue([
      { amount: 50n, txHash: `0x${"ee".repeat(32)}` },
    ])
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc"))
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(store.get(OWNER)!.fundedAt).toBeUndefined()
  })

  it("decides nothing about funding while the floor is unreadable, then decides on the next tick", async () => {
    let clock = 5_000
    const { deps, store, deposits } = resumeDeps({}, { now: () => clock })
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(50n)
    ;(deposits.readFunding as ReturnType<typeof vi.fn>).mockResolvedValue([
      { amount: 50n, txHash: `0x${"ee".repeat(32)}` },
    ])
    ;(deposits.floor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(store.get(OWNER)!.phase).toBe("awaiting_deposit")
    expect(store.get(OWNER)!.fundedAt).toBeUndefined()

    clock += 60_000
    await resumeOxideRegistration(deps)
    expect(store.get(OWNER)!.phase).toBe("funded")
  })

  it("survives a floor read that rejects, and backs off instead of polling fast", async () => {
    const { deps, store, deposits } = resumeDeps({})
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(50n)
    ;(deposits.floor as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc"))
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(store.get(OWNER)!.fundedAt).toBeUndefined()
    // The transient window off the 5_000 clock: the detect cadence would hammer a failing read.
    expect(store.get(OWNER)!.nextAttemptAt).toBe(35_000)
  })

  it("re-broadcasts an un-broadcast record when sign deps are available", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, store } = resumeDeps(
      { broadcast: false },
      { getSignDeps: signDepsWith(broadcast) },
    )
    await resumeOxideRegistration(deps)
    expect(broadcast).toHaveBeenCalledOnce()
    expect(store.get(OWNER)!.broadcast).toBe(true)
  })

  it("leaves an un-broadcast record to the session still proving its broadcast", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, store } = resumeDeps(
      // The harness clock reads 5_000: a start a second ago is still proving.
      { broadcast: false, broadcastStartedAt: 4_000 },
      { getSignDeps: signDepsWith(broadcast) },
    )
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(broadcast).not.toHaveBeenCalled()
    expect(store.get(OWNER)!.broadcast).toBe(false)
  })

  it("re-broadcasts once a started broadcast's window has passed, stamping the new start", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, store } = resumeDeps(
      { broadcast: false, broadcastStartedAt: 5_000 - BROADCAST_IN_FLIGHT_MS - 1 },
      { getSignDeps: signDepsWith(broadcast) },
    )
    await resumeOxideRegistration(deps)
    expect(broadcast).toHaveBeenCalledOnce()
    expect(store.get(OWNER)).toMatchObject({ broadcast: true })
    expect(store.get(OWNER)!.broadcastStartedAt).toBeUndefined()
  })

  it("does not re-broadcast a record whose predecessor spent the account's one-shot rail", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, store } = resumeDeps(
      {
        broadcast: false,
        replaced: { sipaAddress: OTHER_SIPA, refunded: false, broadcastSpent: true },
      },
      { getSignDeps: signDepsWith(broadcast) },
    )
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(broadcast).not.toHaveBeenCalled()
    expect(store.get(OWNER)!.broadcast).toBe(false)
  })

  it("keeps a spent-rail record off the re-broadcast branch past the window, note or no note", async () => {
    const broadcast = vi.fn(async () => {})
    const getSignDeps = vi.fn(signDepsWith(broadcast))
    const { deps, store } = resumeDeps(
      {
        broadcast: false,
        phase: "funded",
        fundedAt: 1,
        replaced: { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true },
      },
      { getSignDeps, broadcastSeen: vi.fn(async () => false), now: () => 400_000 },
    )
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(getSignDeps).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(store.get(OWNER)).toMatchObject({ retries: 0, broadcast: false, phase: "funded" })
  })

  it("renews a spent-rail record's claim on a forced tick, publishing nothing", async () => {
    const broadcast = vi.fn(async () => {})
    const signDeps = await signDepsWith(broadcast)()
    const { deps, store } = resumeDeps(
      {
        broadcast: false,
        replaced: { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true },
      },
      { getSignDeps: vi.fn(async () => signDeps) },
    )
    expect(await resumeOxideRegistration(deps, { force: true })).toBe("pending")
    expect(signDeps.accountService.signDomain).toHaveBeenCalledOnce()
    expect(broadcast).not.toHaveBeenCalled()
    const rec = store.get(OWNER)!
    expect(rec.broadcast).toBe(false)
    expect(rec.lastBroadcastAt).toBeUndefined()
    expect(rec.replaced?.broadcastSpent).toBe(true)
  })

  it("leaves a spent-rail record's claim alone on a forced tick that brings no signer", async () => {
    const { deps, store } = resumeDeps({
      broadcast: false,
      replaced: { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true },
    })
    expect(await resumeOxideRegistration(deps, { force: true })).toBe("pending")
    expect(store.get(OWNER)).toMatchObject({ retries: 0, broadcast: false })
  })

  // The nudge is paced off the last broadcast, not `fundedAt`: `fundedAt` never moves, so keying
  // on it re-broadcasts on every poll once the window passes, a client proof each time, for as
  // long as the sweep keeps failing.
  it("does not re-nudge a funded record inside the window since its last broadcast", async () => {
    const broadcast = vi.fn(async () => {})
    // Funded long ago, nudged since: keyed on `fundedAt` this poll would re-broadcast.
    const { deps, deposits } = resumeDeps(
      { fundedAt: 0, lastBroadcastAt: 1_000 },
      { getSignDeps: signDepsWith(broadcast), now: () => 1_000 + AWAITING_SWEEP_WINDOW_MS },
    )
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(50n)
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(broadcast).not.toHaveBeenCalled()
  })

  it("re-nudges a funded record once the window has passed, re-stamping it", async () => {
    const broadcast = vi.fn(async () => {})
    const nudgedAt = 1_000 + AWAITING_SWEEP_WINDOW_MS + 1
    const { deps, store, deposits } = resumeDeps(
      { fundedAt: 0, lastBroadcastAt: 1_000 },
      { getSignDeps: signDepsWith(broadcast), now: () => nudgedAt },
    )
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(50n)
    await resumeOxideRegistration(deps)
    expect(broadcast).toHaveBeenCalledOnce()
    expect(store.get(OWNER)!.lastBroadcastAt).toBe(nudgedAt)
  })

  // With no note read, an unknown floor still nudges on a visible deposit: the money is there,
  // only its sufficiency is unknown.
  it("re-nudges a record holding a deposit past the window while the floor is unknown", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, store, deposits } = resumeDeps(
      { lastBroadcastAt: 1_000 },
      {
        getSignDeps: signDepsWith(broadcast),
        now: () => 1_000 + AWAITING_SWEEP_WINDOW_MS + 1,
      },
    )
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(50n)
    ;(deposits.floor as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await resumeOxideRegistration(deps)
    expect(broadcast).toHaveBeenCalledOnce()
    expect(store.get(OWNER)!.fundedAt).toBeUndefined()
  })

  it("nudges nothing past the window when neither the balance nor the floor reads", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, store, deposits } = resumeDeps(
      { lastBroadcastAt: 1_000 },
      {
        getSignDeps: signDepsWith(broadcast),
        now: () => 1_000 + AWAITING_SWEEP_WINDOW_MS + 1,
      },
    )
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc"))
    ;(deposits.floor as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(broadcast).not.toHaveBeenCalled()
    expect(store.get(OWNER)!.fundedAt).toBeUndefined()
  })

  // The stamp is submission, not inclusion: past the window the mined note decides.
  it("re-broadcasts a stamped record whose note never appeared, funded or not", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps } = resumeDeps(
      { lastBroadcastAt: 1_000 },
      {
        getSignDeps: signDepsWith(broadcast),
        broadcastSeen: async () => false,
        now: () => 1_000 + AWAITING_SWEEP_WINDOW_MS + 1,
      },
    )
    await resumeOxideRegistration(deps)
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it("does not re-nudge a funded record whose broadcast mined (the rail is spent)", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, deposits } = resumeDeps(
      { fundedAt: 0, lastBroadcastAt: 1_000 },
      {
        getSignDeps: signDepsWith(broadcast),
        broadcastSeen: async () => true,
        now: () => 1_000 + AWAITING_SWEEP_WINDOW_MS + 1,
      },
    )
    ;(deposits.readBalance as ReturnType<typeof vi.fn>).mockResolvedValue(50n)
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(broadcast).not.toHaveBeenCalled()
  })

  it("spends nothing when the note read cannot tell", async () => {
    const broadcast = vi.fn(async () => {})
    const { deps, store } = resumeDeps(
      { lastBroadcastAt: 1_000 },
      {
        getSignDeps: signDepsWith(broadcast),
        broadcastSeen: async () => {
          throw new Error("locked")
        },
        now: () => 1_000 + AWAITING_SWEEP_WINDOW_MS + 1,
      },
    )
    await resumeOxideRegistration(deps)
    expect(broadcast).not.toHaveBeenCalled()
    expect(store.get(OWNER)!.retries).toBe(0)
  })

  it("stays pending (zero budget) on an un-broadcast record with no sign deps", async () => {
    const { deps, store } = resumeDeps({ broadcast: false })
    expect(await resumeOxideRegistration(deps)).toBe("pending")
    expect(store.get(OWNER)!.broadcast).toBe(false)
  })
})

it("signs the original consent digest for an adopted legacy registration SIPA", async () => {
  const { recoveryCommitment: _commitment, ...common } =
    DERIVATION.sipaArgs as import("@oxide/l1-contracts").SipaDeployArgs
  const legacy = { ...DERIVATION, sipaArgs: { ...common, recoveryAddress: OWNER } }
  const { deps, broadcast } = sessionDeps({ deriveRegistrationSipa: async () => legacy })
  const result = await startOxideRegistrationSession(deps)
  expect(result.status).toBe("awaiting_deposit")
  const payload = (broadcast.mock.calls[0] as unknown as [RegistrationBroadcastPayload])[0]
  expect(
    await recoverAddress({
      hash: consentDigest(RECORD_DATA, ENV.l1ChainId, AMR, SIPA),
      signature: payload.consentSig,
    }),
  ).toBe(deriveBootstrapKey(MSK).address)
})
