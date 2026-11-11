// @vitest-environment node
/**
 * Deposit-gated registration (registration-fee.md): the D2 registration-SIPA payload encoding and
 * the session that commits a record. Collaborators are faked at their boundaries over a real store.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, type Hex, getAddress, keccak256, recoverAddress } from "viem"
import {
  buildR1InstallUserOp,
  computeUserOpHash,
  decodeRegistrationIntentData,
} from "@oxide/l1-contracts"

import {
  encodeRegistrationData,
  encodeUserRecord,
  registrationCommitment,
  consentDigest,
} from "../../src/oxide/oxideRegistrationData"
import { deriveBootstrapKey } from "../../src/oxide/oxideAccountKeys"
import { AccountServiceError } from "../../src/oxide/accountServiceClient"
import { startOxideRegistrationSession } from "../../src/oxide/oxideRegistration"
import {
  AMR,
  BENEFICIARY,
  CLAIM,
  CREDENTIAL_ID,
  DERIVATION,
  EARLIER_R1_GAS,
  ENV,
  FEE_TOKEN,
  MSK,
  OTHER_SIPA,
  OWNER,
  R1KEY,
  RECORD,
  RECORD_DATA,
  REGISTRY,
  RESOLVER,
  SIPA,
  recordAt,
  sessionDeps,
} from "./oxideRegistrationFakes"

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

// ── Session ─────────────────────────────────────────────────────────────────

describe("startOxideRegistrationSession", () => {
  it("short-circuits when the name is already registered to our account, closing its record", async () => {
    const { deps, l1, registrations, at } = sessionDeps()
    await startOxideRegistrationSession(deps)
    l1.readUserAddress.mockResolvedValue(OWNER)
    expect((await startOxideRegistrationSession(deps)).status).toBe("registered")
    expect((await at(SIPA))?.phase).toBe("confirmed")
    void registrations
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

  it("closes the account's other open address as replaced, and keeps it", async () => {
    const { deps, registrations, at } = sessionDeps()
    await registrations.start({
      type: "started",
      record: { ...recordAt({ sipaAddress: OTHER_SIPA }) },
    })
    await registrations.apply(OTHER_SIPA, { type: "funded" })
    expect((await startOxideRegistrationSession(deps)).status).toBe("awaiting_deposit")
    expect(await at(OTHER_SIPA)).toMatchObject({
      phase: "replaced",
      fundedAt: expect.any(Number),
    })
    expect(await at(SIPA)).toMatchObject({ phase: "awaiting_deposit" })
    expect(await at(SIPA)).not.toHaveProperty("fundedAt")
  })

  it("re-enters an open address under the renewed terms, keeping its bookmarks", async () => {
    let deadline = 1
    const { deps, registrations, at } = sessionDeps({ termsOf: () => ({ deadline }) })
    await startOxideRegistrationSession(deps)
    await registrations.apply(SIPA, { type: "funded" })
    deadline = 2
    await startOxideRegistrationSession(deps)
    expect(await at(SIPA)).toMatchObject({ phase: "funded", terms: { deadline: 2 } })
  })

  it.each([
    [
      "the refund entry",
      { refundedEntry: { sipaAddress: OTHER_SIPA, recoveryTxHash: CLAIM.signature, amount: "5" } },
    ],
    [
      "the replaced address",
      { replaced: { sipaAddress: OTHER_SIPA, refunded: false, broadcastSpent: true } },
    ],
    ["the terms and route", { termsOf: () => ({ deadline: 9 }), route: "invite" }],
  ])("checkpoints %s with the record, before the consent read", async (_, over) => {
    const { deps, l1, at } = sessionDeps(over)
    l1.readAccountMetadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(startOxideRegistrationSession(deps)).rejects.toThrow("rpc down")
    const { termsOf, ...fields } = over as Record<string, unknown>
    expect(await at(SIPA)).toMatchObject({
      ...fields,
      ...(termsOf ? { terms: { deadline: 9 } } : {}),
    })
  })

  it("owes the broadcast in the write that creates a record whose route confirms the tag", async () => {
    const { deps, sipaDeposits } = sessionDeps({ route: "past_user" })
    await startOxideRegistrationSession(deps)
    expect((await sipaDeposits.get(SIPA))?.broadcast).toMatchObject({
      kind: "registration",
      source: { type: "registration", account: OWNER },
    })
  })

  it.each([
    ["a route the user still settles", { route: "random" }],
    [
      "a ticket signup",
      { route: "invite", termsOf: () => ({ deadline: 1, paylinkFunded: true, paylinkId: "l" }) },
    ],
    [
      "a spent rail",
      {
        route: "invite",
        replaced: { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true },
      },
    ],
  ])("owes nothing at the start for %s", async (_, over) => {
    const { deps, sipaDeposits } = sessionDeps(over)
    await startOxideRegistrationSession(deps)
    expect((await sipaDeposits.get(SIPA))?.broadcast).toBeUndefined()
  })

  it("owes no broadcast when the replaced address spent the account's one-shot rail", async () => {
    const replaced = { sipaAddress: OTHER_SIPA, refunded: true, broadcastSpent: true }
    const { deps, at } = sessionDeps({ replaced })
    const out = await startOxideRegistrationSession(deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    expect(out.broadcastOwed).toBe(false)
    expect(await at(SIPA)).toMatchObject({ broadcast: false, replaced })
  })

  it("signs the R1 install over the wallet's hash of the op built with the controller's limits", async () => {
    const { deps, l1 } = sessionDeps()
    const out = await startOxideRegistrationSession(deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    expect(l1.readR1InstallGas).toHaveBeenCalledWith(REGISTRY)
    const metadata = `0x${Buffer.from(CREDENTIAL_ID, "base64url").toString("hex")}` as Hex
    const op = buildR1InstallUserOp(OWNER, 0n, R1KEY, metadata, EARLIER_R1_GAS)
    expect(
      await recoverAddress({
        hash: computeUserOpHash(ENV.l1ChainId, ENV.entryPoint as Address, op),
        signature: out.payload.r1Install.signature,
      }),
    ).toBe(deriveBootstrapKey(MSK).address)
  })

  it("derives the SIPA, claims, and returns the broadcast it owes without sending it", async () => {
    const { deps, at, signDomain } = sessionDeps()
    const out = await startOxideRegistrationSession(deps)
    if (out.status !== "awaiting_deposit") throw new Error("unreachable")
    expect(out).toMatchObject({ sipaAddress: SIPA, depositToken: FEE_TOKEN, broadcastOwed: true })
    expect(out.payload.registrationData).toBe(DERIVATION.registrationData)
    expect(out.payload.r1Install).toMatchObject({ qx: R1KEY.qx, qy: R1KEY.qy })
    expect(signDomain).toHaveBeenCalledWith({ nameHash: expect.any(String), userAddress: OWNER })
    expect(await at(SIPA)).toMatchObject({
      phase: "awaiting_deposit",
      fee: "1",
      beneficiary: BENEFICIARY,
      broadcast: false,
    })
  })

  it("writes no record and reports taken when the claim server refuses a reserved name", async () => {
    const { deps, at, signDomain } = sessionDeps()
    signDomain.mockRejectedValue(
      new AccountServiceError(409, "reserved", { reason: "name_reserved" }),
    )
    const out = await startOxideRegistrationSession(deps)
    // The refusals lead different places, so which one it was survives the outcome.
    expect(out).toMatchObject({ status: "taken", reason: "reserved" })
    expect(await at(SIPA)).toBeNull()
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

it("signs the original consent digest for an adopted legacy registration SIPA", async () => {
  const { recoveryCommitment: _commitment, ...common } =
    DERIVATION.sipaArgs as import("@oxide/l1-contracts").SipaDeployArgs
  const legacy = { ...DERIVATION, sipaArgs: { ...common, recoveryAddress: OWNER } }
  const { deps } = sessionDeps({ deriveRegistrationSipa: async () => legacy })
  const result = await startOxideRegistrationSession(deps)
  if (result.status !== "awaiting_deposit") throw new Error("unreachable")
  expect(
    await recoverAddress({
      hash: consentDigest(RECORD_DATA, ENV.l1ChainId, AMR, SIPA),
      signature: result.payload.consentSig,
    }),
  ).toBe(deriveBootstrapKey(MSK).address)
})
