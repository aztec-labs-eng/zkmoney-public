import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"

const EXPECTED_SIPA = "0x" + "88".repeat(20)
vi.mock("../../../src/core/services/deposits/sipa", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeStealthRecipientHash: vi.fn(async () => new Fr(8)),
  deriveRecoveryAddress: vi.fn(() => EthAddress.fromString("0x" + "99".repeat(20))),
  computeSIPAAddress: vi.fn(() => EthAddress.fromString(EXPECTED_SIPA)),
}))

import { computeSIPAAddress } from "../../../src/core/services/deposits/sipa"
import { deriveRefundableSipaSources } from "../../../src/core/services/deposits/refundableSipaDiscovery"
import { keccak256 } from "@aztec/foundation/crypto/keccak"
import { computeSIPAAddress as computeAccountSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { computeStealthRecipientHash } from "../../../src/core/services/deposits/sipa"
import { deriveStealthKey } from "../../../src/oxide/oxideAccountKeys"

const RECIPIENT = AztecAddress.fromStringUnsafe("0x" + "00".repeat(30) + "1234")
const SIPA_FACTORY = EthAddress.fromString("0x" + "11".repeat(20))
const IMPLEMENTATION = EthAddress.fromString("0x" + "22".repeat(20))
const STEALTH_KEY = deriveStealthKey(new Fr(5)).publicKey

const tuple = (over: Record<string, unknown> = {}) => ({
  version: "v5",
  gitSha: "test",
  timestamp: "2026-01-01T00:00:00Z",
  portal: "0x" + "55".repeat(20),
  token: "0x" + "66".repeat(20),
  l2Token: "0x" + "77".repeat(32),
  enclaveUrl: "https://enclave.invalid",
  pcr0: "",
  rollupVersion: "5",
  sipaFactory: SIPA_FACTORY.toString(),
  depositSIPAImplementation: IMPLEMENTATION.toString(),
  ...over,
})

describe("deriveRefundableSipaSources", () => {
  it("reconstructs and deduplicates event-owned SIPAs without wallet records", async () => {
    const secret = new Fr(99)

    const sources = await deriveRefundableSipaSources({
      events: [
        { messageSecret: secret.toString(), resweepable: true },
        { messageSecret: secret.toString(), resweepable: true },
      ],
      recipientL2Address: RECIPIENT.toString(),
      stealthPublicKey: STEALTH_KEY,
      tuple: tuple() as never,
    })

    expect(sources).toEqual([
      {
        sipaAddress: EXPECTED_SIPA,
        recipientL2Address: RECIPIENT.toString(),
        messageSecret: secret.toString(),
        // The commitment the (mocked) stealth hash gives, which its sweeps deposit to.
        recipientCommitment: new Fr(8).toString(),
      },
    ])
  })

  it("derives against the tuple's own implementation, never a version pointer", async () => {
    vi.mocked(computeSIPAAddress).mockClear()
    const historic = EthAddress.fromString("0x" + "ab".repeat(20))

    await deriveRefundableSipaSources({
      events: [{ messageSecret: new Fr(99).toString(), resweepable: true }],
      recipientL2Address: RECIPIENT.toString(),
      stealthPublicKey: STEALTH_KEY,
      tuple: tuple({ depositSIPAImplementation: historic.toString() }) as never,
    })

    expect(vi.mocked(computeSIPAAddress).mock.calls[0]![0]!.implementation.toString()).toBe(
      historic.toString(),
    )
  })

  it("fails closed when the deployment tuple cannot derive a SIPA", async () => {
    await expect(
      deriveRefundableSipaSources({
        events: [{ messageSecret: new Fr(1).toString(), resweepable: true }],
        recipientL2Address: RECIPIENT.toString(),
        stealthPublicKey: STEALTH_KEY,
        tuple: tuple({ rollupVersion: "" }) as never,
      }),
    ).rejects.toThrow(/lacks sipaFactory/)
  })

  it("fails closed on a tuple that publishes no deposit implementation", async () => {
    await expect(
      deriveRefundableSipaSources({
        events: [{ messageSecret: new Fr(1).toString(), resweepable: true }],
        recipientL2Address: RECIPIENT.toString(),
        stealthPublicKey: STEALTH_KEY,
        tuple: tuple({ depositSIPAImplementation: undefined }) as never,
      }),
    ).rejects.toThrow(/no depositSIPAImplementation/)
  })

  it("fails closed on a zero deposit implementation", async () => {
    await expect(
      deriveRefundableSipaSources({
        events: [{ messageSecret: new Fr(1).toString(), resweepable: true }],
        recipientL2Address: RECIPIENT.toString(),
        stealthPublicKey: STEALTH_KEY,
        tuple: tuple({ depositSIPAImplementation: "0x" + "00".repeat(20) }) as never,
      }),
    ).rejects.toThrow(/no depositSIPAImplementation/)
  })

  it("commits an account deployment's SIPAs to the owner's recovery account", async () => {
    vi.mocked(computeSIPAAddress).mockClear()
    const secret = new Fr(7)
    const recoveryAccount = EthAddress.fromString("0x" + "cd".repeat(20))

    const sources = await deriveRefundableSipaSources({
      events: [{ messageSecret: secret.toString(), resweepable: false }],
      recipientL2Address: RECIPIENT.toString(),
      stealthPublicKey: STEALTH_KEY,
      tuple: tuple({ sipaRecoveryProtocol: "account" }) as never,
      recoveryAccount: recoveryAccount.toString(),
    })

    const recipientCommitment = await computeStealthRecipientHash(secret, RECIPIENT)
    expect(sources.map((s) => s.sipaAddress)).toEqual([
      computeAccountSIPAAddress({
        sipaFactory: SIPA_FACTORY,
        implementation: IMPLEMENTATION,
        intentHash: keccak256(recipientCommitment.toBuffer()),
        recoveryCommitment: deriveRecoveryCommitment(secret, recoveryAccount),
        rollupVersion: 5n,
        resweepable: false,
      }).toString(),
    ])
    expect(vi.mocked(computeSIPAAddress)).not.toHaveBeenCalled()
  })

  it("fails closed on an account deployment without the recovery account", async () => {
    await expect(
      deriveRefundableSipaSources({
        events: [{ messageSecret: new Fr(1).toString(), resweepable: true }],
        recipientL2Address: RECIPIENT.toString(),
        stealthPublicKey: STEALTH_KEY,
        tuple: tuple({ sipaRecoveryProtocol: "account" }) as never,
      }),
    ).rejects.toThrow(/recovery account/)
  })

  describe("a SIPA announced with another intent", () => {
    const recoveryAccount = EthAddress.fromString("0x" + "cd".repeat(20))
    const registration = EthAddress.fromString("0x" + "33".repeat(20))
    const metadataUpdate = EthAddress.fromString("0x" + "44".repeat(20))
    const secret = new Fr(7)
    const intentHash = "0x" + "e1".repeat(32)
    const derive = (events: object[], over: Record<string, unknown> = {}) =>
      deriveRefundableSipaSources({
        events: events as never,
        recipientL2Address: RECIPIENT.toString(),
        stealthPublicKey: STEALTH_KEY,
        tuple: tuple({
          sipaRecoveryProtocol: "account",
          registrationSIPAImplementation: registration.toString(),
          updateMetadataSIPAImplementation: metadataUpdate.toString(),
          ...over,
        }) as never,
        recoveryAccount: recoveryAccount.toString(),
      })
    const address = (implementation: EthAddress, hash: Buffer, resweepable = false) =>
      computeAccountSIPAAddress({
        sipaFactory: SIPA_FACTORY,
        implementation,
        intentHash: hash,
        recoveryCommitment: deriveRecoveryCommitment(secret, recoveryAccount),
        rollupVersion: 5n,
        resweepable,
      }).toString()

    it("derives a registration or metadata-update SIPA from the carried intent hash", async () => {
      const sources = await derive([
        { messageSecret: secret.toString(), resweepable: false, intentHash },
      ])
      const carried = Buffer.from(intentHash.slice(2), "hex")
      expect(sources.map((s) => s.sipaAddress)).toEqual([
        address(registration, carried),
        address(metadataUpdate, carried),
      ])
    })

    it("reads a zero intent hash as a deposit", async () => {
      const deposit = keccak256((await computeStealthRecipientHash(secret, RECIPIENT)).toBuffer())
      const sources = await derive([
        { messageSecret: secret.toString(), resweepable: false, intentHash: "0x0" },
      ])
      expect(sources.map((s) => s.sipaAddress)).toEqual([address(IMPLEMENTATION, deposit)])
    })

    it("keeps one salt's SIPAs apart when their intent or resweepability differs", async () => {
      const sources = await derive(
        [
          { messageSecret: secret.toString(), resweepable: false },
          { messageSecret: secret.toString(), resweepable: true },
          { messageSecret: secret.toString(), resweepable: false, intentHash },
        ],
        { updateMetadataSIPAImplementation: undefined },
      )
      expect(new Set(sources.map((s) => s.sipaAddress)).size).toBe(3)
    })

    it("fails closed when the tuple cannot derive that intent", async () => {
      await expect(
        derive([{ messageSecret: secret.toString(), resweepable: false, intentHash }], {
          registrationSIPAImplementation: undefined,
          updateMetadataSIPAImplementation: "0x" + "00".repeat(20),
        }),
      ).rejects.toThrow(/no registration or metadata-update/)
    })
  })
})
