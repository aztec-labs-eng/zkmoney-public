// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { keccak256, type Address, type Hex } from "viem"
import { secp256k1 } from "@noble/curves/secp256k1"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { encodeDepositIntentData } from "@oxide/l1-contracts"
import { computeSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"

const mocks = vi.hoisted(() => ({ readAccountResolution: vi.fn() }))

// The derivation runs for real. Only the chain reads are stubbed: the resolver's records and each
// factory's deposit implementation.
vi.mock("@obsidion/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@obsidion/sdk")>()
  return {
    ...actual,
    readAccountResolution: mocks.readAccountResolution,
    readDepositSIPAImplementation: vi.fn(async (_client: unknown, factory: string) =>
      factory.toLowerCase() === SUSDS_FACTORY ? SUSDS_IMPLEMENTATION : DAI_IMPLEMENTATION,
    ),
  }
})

import { computeStealthRecipientHash, deriveSharedSecret } from "@obsidion/sdk"
import {
  createResolverWindow,
  readResolverDeployments,
  type ResolverDeployment,
  type ResolverDeploymentSource,
} from "../../src/oxide/resolverPayments"

const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b"
const SUSDS = "0x5a1e0c2f3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f"
const DAI_PORTAL = "0xda10000000000000000000000000000000000001"
const SUSDS_PORTAL = "0x5005000000000000000000000000000000000002"
const DAI_TABLE = "0xda20000000000000000000000000000000000003"
const SUSDS_TABLE = "0x5006000000000000000000000000000000000004"
const DAI_FACTORY = "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2"
const SUSDS_FACTORY = "0x4a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b"
const DAI_IMPLEMENTATION = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4"
const SUSDS_IMPLEMENTATION = "0x6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"
const ACCOUNT_FACTORY = "0x8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c"
const REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f"
const RECOVERY_ACCOUNT = "0x4444444444444444444444444444444444444444" as Address
const RECIPIENT = AztecAddress.fromStringUnsafe(
  "0x0aa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
)
const ROLLUP_VERSION = 4127419662n

const point = (scalar: bigint) => {
  const p = secp256k1.ProjectivePoint.BASE.multiply(scalar).toAffine()
  return { x: p.x, y: p.y }
}
const STEALTH_SCALAR = 0x1f2e3d4c5b6a79881726354453627180918273645546372819a0b1c2d3e4f5a6n
const RESOLVER_SCALAR = 0x0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20212223242526272829n
const STEALTH_PUBLIC = point(STEALTH_SCALAR)
const RESOLVER_PUBLIC = point(RESOLVER_SCALAR)
const KEYS = { stealthScalar: STEALTH_SCALAR, recipient: RECIPIENT }

const NOW = Date.UTC(2026, 0, 15, 12)
const TODAY = Math.floor(NOW / 1000 / 86_400)
const DAY_MS = 86_400_000

const DAI_TOKEN = { address: DAI as Address, symbol: "DAI", decimals: 18 }
const SUSDS_TOKEN = { address: SUSDS as Address, symbol: "sUSDS", decimals: 18 }

const deployment = (asset: "DAI" | "sUSDS"): ResolverDeployment =>
  asset === "DAI"
    ? {
        portal: DAI_PORTAL as Address,
        sipaFactory: DAI_FACTORY as Address,
        forwardingTable: DAI_TABLE as Address,
        implementation: DAI_IMPLEMENTATION as Address,
        rollupVersion: ROLLUP_VERSION,
        resolverPublicKey: RESOLVER_PUBLIC,
        recoveryAccount: RECOVERY_ACCOUNT,
        accountFactory: ACCOUNT_FACTORY as Address,
        tokens: [DAI_TOKEN],
      }
    : {
        portal: SUSDS_PORTAL as Address,
        sipaFactory: SUSDS_FACTORY as Address,
        forwardingTable: SUSDS_TABLE as Address,
        implementation: SUSDS_IMPLEMENTATION as Address,
        rollupVersion: ROLLUP_VERSION,
        resolverPublicKey: RESOLVER_PUBLIC,
        recoveryAccount: RECOVERY_ACCOUNT,
        accountFactory: ACCOUNT_FACTORY as Address,
        tokens: [SUSDS_TOKEN],
      }

/**
 * What the oxide gateway hands out at `(day, nonce)`, computed from the resolver's side of the
 * ECDH: its private key against the account's registered public key.
 */
async function resolverHandsOut(d: ResolverDeployment, day: number, nonce: number) {
  const salt = deriveSharedSecret(STEALTH_PUBLIC, RESOLVER_SCALAR, day, nonce)
  const recipientCommitment = (await computeStealthRecipientHash(salt, RECIPIENT)).toString() as Hex
  const intentHash = keccak256(encodeDepositIntentData(recipientCommitment))
  const address = computeSIPAAddress({
    sipaFactory: EthAddress.fromString(d.sipaFactory),
    implementation: EthAddress.fromString(d.implementation),
    intentHash: Buffer.from(intentHash.slice(2), "hex"),
    recoveryCommitment: deriveRecoveryCommitment(salt, EthAddress.fromString(d.recoveryAccount)),
    forwardingTable: EthAddress.fromString(d.forwardingTable),
    rollupVersion: d.rollupVersion,
    resweepable: true,
  })
  return { address: address.toString().toLowerCase(), salt, recipientCommitment, intentHash }
}

async function handedOut(d: ResolverDeployment, day: number, nonces: number[]) {
  return Promise.all(nonces.map(async (n) => (await resolverHandsOut(d, day, n)).address))
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

/** A held record at `address` under `salt`. */
const held = (address: string, salt: { toString(): string }) =>
  ({ sipaAddress: address, messageSecret: salt.toString() } as SipaDeposit)

const addresses = (candidates: { sipaAddress: string }[]) =>
  candidates.map((c) => c.sipaAddress.toLowerCase())

beforeEach(() => {
  mocks.readAccountResolution.mockReset()
})

describe("createResolverWindow", () => {
  it("names the addresses each deployment's resolver hands out for yesterday and today", async () => {
    const window = createResolverWindow()
    const [dai, susds] = [deployment("DAI"), deployment("sUSDS")]

    const candidates = await window(KEYS, [dai, susds], [], NOW)

    const nonces = range(0, 8)
    expect(addresses(candidates)).toEqual([
      ...(await handedOut(dai, TODAY - 1, nonces)),
      ...(await handedOut(dai, TODAY, nonces)),
      ...(await handedOut(susds, TODAY - 1, nonces)),
      ...(await handedOut(susds, TODAY, nonces)),
    ])
    const paid = await resolverHandsOut(dai, TODAY, 2)
    expect(candidates.find((c) => c.sipaAddress.toLowerCase() === paid.address)).toMatchObject({
      messageSecret: paid.salt.toString(),
      recipientHash: paid.recipientCommitment,
      origin: {
        protocol: "account",
        sipaFactory: DAI_FACTORY,
        implementation: DAI_IMPLEMENTATION,
        intentHash: paid.intentHash,
        resweepable: true,
        recoveryAccount: RECOVERY_ACCOUNT,
      },
    })
  })

  it("moves past each used nonce and leaves the recorded address out", async () => {
    const dai = deployment("DAI")
    const used = await resolverHandsOut(dai, TODAY, 2)

    const candidates = await createResolverWindow()(
      KEYS,
      [dai],
      [held(used.address, used.salt)],
      NOW,
    )

    // Nonces 0 and 1 were handed out before 2 and may still be paid; 3..10 are the look-ahead.
    expect(addresses(candidates).slice(8)).toEqual(
      await handedOut(dai, TODAY, [0, 1, ...range(3, 11)]),
    )
    expect(addresses(candidates).slice(0, 8)).toEqual(await handedOut(dai, TODAY - 1, range(0, 8)))
  })

  it("never derives past the per-day bound however far the used nonces reach", async () => {
    const dai = deployment("DAI")
    const records = await Promise.all(
      range(0, 40).map(async (nonce) => {
        const { address, salt } = await resolverHandsOut(dai, TODAY, nonce)
        return held(address, salt)
      }),
    )

    const candidates = await createResolverWindow()(KEYS, [dai], records, NOW)

    expect(addresses(candidates)).toEqual(await handedOut(dai, TODAY - 1, range(0, 8)))
  })

  it("moves to the next day with the time it is given", async () => {
    const dai = deployment("DAI")

    const candidates = await createResolverWindow()(KEYS, [dai], [], NOW + DAY_MS)

    expect(addresses(candidates)).toEqual([
      ...(await handedOut(dai, TODAY, range(0, 8))),
      ...(await handedOut(dai, TODAY + 1, range(0, 8))),
    ])
  })

  it("derives new addresses when a refreshed deployment changes an input", async () => {
    const window = createResolverWindow()
    const dai = deployment("DAI")
    await window(KEYS, [dai], [], NOW)
    const changed = { ...dai, implementation: SUSDS_IMPLEMENTATION as Address }

    const candidates = await window(KEYS, [changed], [], NOW)

    expect(addresses(candidates)).toEqual([
      ...(await handedOut(changed, TODAY - 1, range(0, 8))),
      ...(await handedOut(changed, TODAY, range(0, 8))),
    ])
  })

  it("leaves out an address discovery already holds under the same salt", async () => {
    const dai = deployment("DAI")
    const paid = await resolverHandsOut(dai, TODAY, 0)

    const candidates = await createResolverWindow()(
      KEYS,
      [dai],
      [held("0x1111111111111111111111111111111111111111", paid.salt)],
      NOW,
    )

    expect(addresses(candidates)).not.toContain(paid.address)
  })
})

describe("readResolverDeployments", () => {
  const daiTuple = {
    portal: DAI_PORTAL,
    sipaFactory: DAI_FACTORY,
    forwardingTable: DAI_TABLE,
    accountFactory: ACCOUNT_FACTORY,
    accountMetadataRegistry: REGISTRY,
  } as unknown as OxideEnvTuple
  const susdsTuple = {
    ...daiTuple,
    portal: SUSDS_PORTAL,
    sipaFactory: SUSDS_FACTORY,
    forwardingTable: SUSDS_TABLE,
  }
  const sources: ResolverDeploymentSource[] = [
    { tuple: daiTuple, tokens: [DAI_TOKEN] },
    { tuple: susdsTuple, tokens: [SUSDS_TOKEN] },
  ]
  const resolution = (forwardingTable: string, publicKey = STEALTH_PUBLIC) => ({
    l2Address: RECIPIENT.toString(),
    rollupVersion: ROLLUP_VERSION,
    publicKey,
    operator: {
      owner: "0x0e00000000000000000000000000000000000003",
      l2Address: "0x01",
      url: "https://resolver.test/{sender}/{data}.json",
      forwardingTable,
      resolverPublicKey: RESOLVER_PUBLIC,
    },
  })
  const read = (s: ResolverDeploymentSource[]) =>
    readResolverDeployments({
      publicClient: {} as never,
      sources: s,
      recoveryAccount: RECOVERY_ACCOUNT,
      recipient: RECIPIENT,
      stealthPublicKey: STEALTH_PUBLIC,
    })

  it("serves only the forwarding table the account's operator names, with that deployment's tokens", async () => {
    mocks.readAccountResolution.mockResolvedValue(resolution(DAI_TABLE))

    expect(await read(sources)).toEqual([deployment("DAI")])
    // One registry, read once.
    expect(mocks.readAccountResolution).toHaveBeenCalledOnce()
  })

  it("serves a second asset whose own registry names an operator on its forwarding table", async () => {
    const own = {
      ...susdsTuple,
      accountMetadataRegistry: "0x7777777777777777777777777777777777777777",
    }
    mocks.readAccountResolution.mockImplementation(async (_c: unknown, registry: string) =>
      resolution(registry === REGISTRY ? DAI_TABLE : SUSDS_TABLE),
    )

    expect(await read([sources[0]!, { tuple: own, tokens: [SUSDS_TOKEN] }])).toEqual([
      deployment("DAI"),
      deployment("sUSDS"),
    ])
  })

  it("skips an account with no record, or one recorded under another key", async () => {
    mocks.readAccountResolution.mockResolvedValueOnce(null)
    expect(await read(sources)).toEqual([])
    mocks.readAccountResolution.mockResolvedValueOnce(resolution(DAI_TABLE, RESOLVER_PUBLIC))
    expect(await read(sources)).toEqual([])
  })
})
