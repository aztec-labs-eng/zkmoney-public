/**
 * The shared migration session keeps a run's approvals under the passkey that signs them, for the
 * record update and the source's refund prompts alike: another passkey on the same run is asked
 * again, and the first passkey's saved approvals answer when it returns.
 */
import { describe, expect, it, vi } from "vitest"

type Hex = `0x${string}`
type RecordSigner = (userOpHash: Hex, expectedStateHash: Hex) => Promise<unknown>

const h = vi.hoisted(() => ({
  services: [] as Array<{ signRecordUpdate: RecordSigner }>,
  recordNamesOtherAccount: vi.fn(async () => true),
}))

vi.mock("@obsidion/sdk", () => ({
  MetadataMigrationService: class {
    constructor(o: { signRecordUpdate: RecordSigner }) {
      h.services.push(o)
    }
  },
  readBridgeDestination: async () => ({
    metadataRegistry: "0x1",
    forwardingTable: "0x2",
    nameRegistry: "0x3",
    rollupVersion: "7",
  }),
  metadataMigrationContext: async () => ({}),
  readNameClaimLog: vi.fn(),
  recordNamesOtherAccount: h.recordNamesOtherAccount,
  SipaSelfResolver: class {
    userPublicKey = "0xpk"
  },
  fetchSipaResolverOperators: async () => [],
  resolverSelectionPolicy: () => ({}),
  selectManifestResolverOperator: () => ({ owner: "0xop" }),
}))
vi.mock("../../src/oxide/oxideAccountKeys", async (original) => ({
  ...(await original<typeof import("../../src/oxide/oxideAccountKeys")>()),
  deriveBootstrapKey: () => ({ address: "0xboot" }),
  selfSipaResolverKeys: () => ({}),
}))
vi.mock("../../src/oxide/metadataMigrationBinding", () => ({ metadataMigrationBinding: vi.fn() }))
vi.mock("../../src/oxide/deploymentScanRange", () => ({ deploymentScanRange: async () => ({}) }))
vi.mock("../../src/oxide/oxideRegistrationDeps", () => ({
  createOxideL1Reader: () => ({ predictAccountAddress: async () => "0xowner" }),
  resolveOxideAccountFactory: () => "0xfactory",
}))

const { accountRecordStale, createMetadataMigrationSession } = await import(
  "../../src/core/migration/createMetadataMigrationSession"
)

type RefundSigner = (challenge: Buffer) => Promise<unknown>

function memory() {
  const items = new Map<string, string>()
  return {
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value)
    },
  }
}

const assertion = () => ({
  signature: new Uint8Array([1]),
  authenticatorData: new Uint8Array([2]),
  clientDataJSON: new TextEncoder().encode("{}"),
})

const passkey = (qx: string, qy: string) => ({
  key: { qx, qy },
  record: vi.fn(async () => ({
    signature: `0x${"11".repeat(64)}`,
    webauthn: { authenticatorData: "0x22", clientDataJSON: "{}", challengeIndex: 0, typeIndex: 0 },
  })),
  refund: vi.fn(async () => assertion()),
})

async function compose(storage: ReturnType<typeof memory>, who: ReturnType<typeof passkey>) {
  let wrapped: RefundSigner | undefined
  await createMetadataMigrationSession({
    wallet: {} as never,
    account: { getAddress: () => "0xl2" } as never,
    contracts: {} as never,
    tokenService: {} as never,
    current: { portal: "0xportal" } as never,
    network: "sandbox" as never,
    secretKey: {} as never,
    client: {} as never,
    storage,
    lock: (fn) => fn(),
    key: "run",
    passkey: { publicKey: who.key as never, signChallenge: who.record as never },
    source: async (_context, _batches, savedRefundSigner) => {
      wrapped = savedRefundSigner(who.refund as never) as unknown as RefundSigner
      return {} as never
    },
  })
  return { refund: wrapped!, record: h.services.at(-1)!.signRecordUpdate }
}

describe("the migration session's approvals", () => {
  const userOpHash = `0x${"bb".repeat(32)}` as const
  const state = `0x${"cc".repeat(32)}` as const

  it("are the signing passkey's own, for the record update and the source's refunds alike", async () => {
    const storage = memory()
    const challenge = Buffer.from("aa".repeat(32), "hex")
    const alice = passkey("0x01", "0x02")
    const bob = passkey("0x03", "0x04")

    const first = await compose(storage, alice)
    await first.refund(challenge)
    await first.record(userOpHash, state)
    const second = await compose(storage, bob)
    await second.refund(challenge)
    await second.record(userOpHash, state)
    expect(bob.refund).toHaveBeenCalledOnce()
    expect(bob.record).toHaveBeenCalledOnce()

    const again = await compose(storage, alice)
    await again.refund(challenge)
    await again.record(userOpHash, state)
    expect(alice.refund).toHaveBeenCalledOnce()
    expect(alice.record).toHaveBeenCalledOnce()
  })

  it("hold a record update's approval only over the record state it was given for", async () => {
    const storage = memory()
    const alice = passkey("0x01", "0x02")

    await (await compose(storage, alice)).record(userOpHash, state)
    await (await compose(storage, alice)).record(userOpHash, state)
    expect(alice.record).toHaveBeenCalledOnce()

    // The record moved and the nonce did not: the same user operation hash asks again.
    await (await compose(storage, alice)).record(userOpHash, `0x${"dd".repeat(32)}`)
    expect(alice.record).toHaveBeenCalledTimes(2)
  })
})

describe("the account record check", () => {
  it("asks whether the owner's record names this account on the destination rollup", async () => {
    const stale = await accountRecordStale({
      account: { getAddress: () => "0xl2" } as never,
      current: { portal: "0xportal" } as never,
      secretKey: {} as never,
      client: {} as never,
    })

    expect(stale).toBe(true)
    expect(h.recordNamesOtherAccount).toHaveBeenCalledWith({}, "0x1", "0xowner", "0xl2", "7")
  })
})
