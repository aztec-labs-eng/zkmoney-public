// @vitest-environment node
import { Fr } from "@aztec-labs/aztec.js/fields"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { deriveBootstrapKey, fixed, fundingLocalId, persistedRotation } from "@obsidion/front-core"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import {
  encodeUserHandle,
  runBackupPasskeyCreation,
  type PasskeyCeremony,
} from "@obsidion/passkey-web"
import { RevertingSweepError } from "@obsidion/sdk"
import type { FundingAmount, ObsidionWallet } from "@obsidion/sdk"
import { TransactionReceiptNotFoundError } from "viem"
import type { Address } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { seedDeviceKeys } from "../../support/page"
import { fakeReads } from "../../support/fakeReads"
import { openTestSession } from "../../support/session"
import { savedIdentity, setIdentity } from "../../support/identity"
import {
  DepositReadError,
  EmptyDepositError,
} from "../../../src/features/deposit/depositReadErrors"
import { closeSession, type Session } from "../../../src/session/session"
import {
  OWNER as RECORD_OWNER,
  PLAN,
  SIPA,
  addr,
  signedRecord,
  storedRotation,
  testRotations,
  word,
} from "../../support/backupAdd"
import catalogCopy from "../../../src/errors/catalog.copy"

// What the flow's dependencies read off the session and the other services, set per test.
const fakes = vi.hoisted(() => ({
  store: {} as unknown,
  keys: undefined as unknown,
  sponsor: { fpcAddress: { fpc: true }, fpcArtifact: { artifact: true } },
  tokenService: {
    setTeeSigner: vi.fn(),
    sendTokenSponsored: vi.fn(async () => undefined),
    fetchTokenInformation: vi.fn(async () => ({ symbol: "DAI", decimals: 18 })),
    exitToL1PrivateSponsored: vi.fn(
      async (..._args: unknown[]): Promise<{ txHash: string; blockNumber?: number }> => ({
        txHash: `0x${"01".repeat(32)}`,
      }),
    ),
  },
  burnHash: `0x${"01".repeat(32)}`,
  sweepFloor: 0n,
  client: {} as unknown,
  tuple: {} as unknown,
  observe: vi.fn(),
  seed: vi.fn(),
  readStrandedToken: vi.fn(),
  envFactory: `0x${"af".repeat(20)}`,
  generations: vi.fn(),
  savings: Promise.resolve(undefined) as Promise<unknown>,
  readSpendShape: vi.fn(),
  prepareBackupRotation: vi.fn(),
  fundingAmount: vi.fn(),
  rows: [] as Record<string, unknown>[],
  ops: [] as Record<string, unknown>[],
  recover: vi.fn(async (..._args: unknown[]) => "0xrefund"),
  linkRefundable: vi.fn(async (..._args: unknown[]) => "now" as const),
}))

const DAI = 10n ** 18n
const MAIN_TOKEN = `0x${"2a".repeat(32)}`
const SAVINGS_TOKEN = `0x${"5a".repeat(32)}`
const SAVINGS_PORTAL = `0x${"5b".repeat(20)}`

const ACCOUNT_FACTORY = `0x${"af".repeat(20)}`
const h = vi.hoisted(() => ({ auth: { providerFor: () => ({}) } as Record<string, unknown> }))
const fakeAuth = () => h.auth
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  l1PublicClient: () => fakes.client,
}))
vi.mock("../../../src/features/registration/oxideGenerations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/registration/oxideGenerations")>()),
  loadOxideGenerations: fakes.generations,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  observeSipas: fakes.observe,
}))
vi.mock("../../../src/features/deposit/recovery/sipaRecovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/deposit/recovery/sipaRecovery")>()),
  readStrandedToken: fakes.readStrandedToken,
}))
vi.mock("../../../src/features/backupPasskey/rotationPublish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/backupPasskey/rotationPublish")>()),
  seedRotationDeposit: fakes.seed,
}))
vi.mock("../../../src/features/registration/registrationResume", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/features/registration/registrationResume")
  >()
  return {
    ...real,
    unlockedSessionKeys: (async (...args) =>
      fakes.keys ?? real.unlockedSessionKeys(...args)) as typeof real.unlockedSessionKeys,
  }
})
vi.mock("../../../src/config/classArtifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/classArtifacts")>()),
  getWebOxideToken: async (_wallet: unknown, _contracts: unknown, token: string) => ({ token }),
}))
vi.mock("../../../src/features/token/l2TokenService", () => ({
  l2TokenService: () => fakes.tokenService,
}))
vi.mock("../../../src/features/registration/claimSponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/registration/claimSponsorship")>()),
  claimSponsorContext: async () => fakes.sponsor,
}))
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({
  recoverSponsoredLink: fakes.recover,
  linkRefundable: fakes.linkRefundable,
  // Found by the link's secret, as the real lookup does.
  creatorLinkFor: async (_stores: unknown, fragment: string) =>
    fakes.rows.find((row) => `frag-${row.secret}` === fragment) ?? null,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readBridgeDestination: async () => fakes.tuple,
  readSpendShape: fakes.readSpendShape,
  prepareBackupRotation: fakes.prepareBackupRotation,
  fundingAmount: fakes.fundingAmount,
  buildBackupSweep: async () => ({ sweep: true }),
  // The sweep pays out what the deposit address holds, against the relayer floor the test sets.
  quoteBackupSweep: async (_client: unknown, { funding }: { funding: bigint }) => ({
    payout: funding,
    floor: fakes.sweepFloor,
  }),
}))
const {
  backupUserName,
  buildBackupAddDeps,
  buildBackupFlowDeps,
  depositedAmount,
  signedChangeFor,
  sweepFunding,
} = await import("../../../src/features/backupPasskey/backupPasskeyRuntime")

const OWNER = `0x${"ab".repeat(20)}` as Address

/** The page reads this file drives. */
const READS = fakeReads({
  feeTokenBridgeTuple: async () => ({
    plainWithdrawalExecutor: `0x${"e8".repeat(20)}`,
    l2Token: `0x${"2a".repeat(32)}`,
    portal: `0x${"b0".repeat(20)}`,
  }),
  // The funding's executor charges nothing.
  withdrawalExecutorAt: async () => ({
    kind: "plain",
    address: `0x${"e8".repeat(20)}`,
    portal: `0x${"b0".repeat(20)}`,
    fee: 0n,
  }),
  oxideEnv: async () => ({
    resolver: { owner: `0x${"0d".repeat(20)}` },
    env: { factory: fakes.envFactory },
  }),
  bridgeOfToken: async (token: string) => ({
    portal: token === SAVINGS_TOKEN ? SAVINGS_PORTAL : `0x${"b0".repeat(20)}`,
  }),
  txAmountCap: async (portal: string) => (portal === SAVINGS_PORTAL ? 7n * DAI : 2n * DAI),
  teeSignerOfToken: async () => ({}),
  savingsTuple: () => fakes.savings,
})

/** Opens the suite's session over the chain reads, with an estimator that has seen no proofs. */
const openReading = () => {
  const { page } = openTestSession({ auth: fakeAuth() })
  Object.assign(page.chain, READS)
  Object.assign(page, {
    speedupEstimator: fixed("speedupEstimator", { calibrate: async () => undefined }),
  })
}

beforeEach(async () => {
  await seedDeviceKeys({ credentialId: "root-credential" })
  openReading()
})

const view = (records: () => unknown[]) => ({
  get: () => ({ records: records(), loaded: true, failed: false }),
  subscribe: () => () => {},
})
/** The open session over `wallet`, with the paylink and operation rows this file drives, over `rotations`. */
const sessionWith = (rotations: unknown = fakes.store, wallet: unknown = {}): Session => {
  const open = openTestSession()
  return Object.assign(Object.create(open), {
    paylinks: { view: view(() => fakes.rows) },
    // The listed rows are the test's; the writes stay the store's, for the funding's operation.
    operations: { ...open.operations, view: view(() => fakes.ops) },
    backupRotations: rotations,
    wallet: fixed("wallet", wallet),
  })
}

describe("buildBackupAddDeps", () => {
  it("creates through the auth service under the session's name, with the pick and the signal", async () => {
    const secret = Buffer.alloc(32, 7)
    const seen: Record<string, unknown>[] = []
    const creation = { kind: "creation" }
    Object.assign(h.auth, {
      sessionKeys: async () => ({
        secretKey: { toBuffer: () => secret },
        authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] },
      }),
      createBackupPasskey: async (
        driver: unknown,
        ceremony: unknown,
        opts: Record<string, unknown>,
      ) => {
        seen.push({ driver, ceremony, ...opts })
        return creation
      },
    })
    const wallet = { createObsidionAccount: async () => ({}) } as unknown as ObsidionWallet
    const ceremony = { kind: "ceremony" } as unknown as PasskeyCeremony
    const observe = () => {}
    const signal = new AbortController().signal

    const rotations = testRotations()
    const picked = await buildBackupAddDeps({
      session: sessionWith(rotations, wallet),
      owner: OWNER,
      choice: "phone",
    })
    expect(picked.owner).toBe(OWNER)
    expect(picked.store).toBe(rotations)
    expect(picked.masterKey()).toEqual(new Uint8Array(secret))
    await expect(picked.create(ceremony, observe, signal)).resolves.toBe(creation)
    expect(seen[0]).toEqual({
      driver: runBackupPasskeyCreation,
      ceremony,
      userName: "0xabab…abab",
      choice: "phone",
      observe,
      signal,
    })

    const unpicked = await buildBackupAddDeps({
      session: sessionWith(rotations, wallet),
      owner: OWNER,
    })
    await unpicked.create(ceremony, observe)
    expect(seen[1]).toEqual({
      driver: runBackupPasskeyCreation,
      ceremony,
      userName: "0xabab…abab",
      observe,
    })
  })
})

describe("backupUserName", () => {
  it("uses the tag when the identity has one", () => {
    expect(backupUserName("brave-otter-42", OWNER)).toBe("brave-otter-42")
  })

  it("falls back to a short owner the user handle accepts", () => {
    for (const handle of [undefined, ""]) {
      const name = backupUserName(handle, OWNER)
      expect(name).toBe("0xabab…abab")
      expect(() => encodeUserHandle(name)).not.toThrow()
    }
    expect(() => encodeUserHandle(OWNER)).toThrow()
  })
})

describe("sweepFunding", () => {
  const live = (over: Partial<FundingAmount["breakdown"]> = {}): FundingAmount => {
    const breakdown = {
      withdrawalFee: 10n,
      proverTip: 0n,
      relayerTip: 5n,
      sweepTip: 7n,
      beneficiaryFee: 3n,
      minCredited: 100n,
      margin: 50n,
      ...over,
    }
    const credited = breakdown.minCredited + breakdown.margin
    const b = breakdown
    return {
      amount:
        b.withdrawalFee + b.proverTip + b.relayerTip + b.sweepTip + b.beneficiaryFee + credited,
      credited,
      breakdown,
    }
  }

  it("is what the deposit address holds once the funding is withdrawn: the live amount before a plan, the saved one after", () => {
    expect(sweepFunding(live(), undefined)).toBe(7n + 3n + 150n)
    expect(sweepFunding(live(), "175")).toBe(160n)
  })

  it("keeps for the plan what reaches the deposit address, without the withdrawal's charges", () => {
    expect(depositedAmount(live(), 175n)).toBe(160n)
    expect(depositedAmount(live({ proverTip: 4n }), 175n)).toBe(156n)
  })

  it("refuses a saved funding the route's current charges no longer leave sweepable", () => {
    expect(sweepFunding(live({ withdrawalFee: 70n }), "175")).toBeUndefined()
    expect(sweepFunding(live({ minCredited: 200n }), "175")).toBeUndefined()
    expect(sweepFunding(live({ sweepTip: 60n }), "175")).toBeUndefined()
  })
})

describe("the route check", () => {
  const rotation = persistedRotation(storedRotation())

  const setup = async () => {
    const root = storedRotation().expectedKeys[0]!.key
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: {},
      authProvider: {},
    }
    fakes.store = testRotations()
    openTestSession({ contractService: {} })
    const wallet = {
      deriveAccountAddress: async () => ({ toString: () => PLAN.address }),
    } as unknown as ObsidionWallet
    return buildBackupFlowDeps({ owner: RECORD_OWNER, session: sessionWith(undefined, wallet) })
  }

  it("parks on the route when the chain refuses the sweep", async () => {
    const deps = await setup()
    // Any refusal the sdk names parks, whichever read raised it.
    fakes.fundingAmount.mockRejectedValueOnce(new RevertingSweepError("does not run", new Error()))
    expect(await deps.route(rotation)).toBe("route")
  })

  it("throws a read that did not complete, so the check is tried again", async () => {
    const deps = await setup()
    const failed = new Error("fetch failed")
    fakes.fundingAmount.mockRejectedValueOnce(failed)
    await expect(deps.route(rotation)).rejects.toBe(failed)
  })
})

describe("signedChangeFor", () => {
  const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
  const rotation = {
    expectedKeys: [{ key: { qx: word(14), qy: word(15) } }],
    builtOver: { l2Address: word(10) },
    add: { pubkey: { qx: word(21), qy: word(22) } },
  }
  const root = `${word(14).slice(2)}${word(15).slice(2)}`

  it("refuses a session signed in with another passkey", () => {
    const other = `${word(21).slice(2)}${word(22).slice(2)}`
    expect(() => signedChangeFor(rotation, other)).toThrow("first passkey")
    expect(() => signedChangeFor({ ...rotation, expectedKeys: [] }, root)).toThrow("first passkey")
  })

  it("refuses a record with nothing signed", () => {
    expect(() => signedChangeFor(undefined, root)).toThrow("nothing signed")
  })
})

describe("the move's send", () => {
  /** Flow deps over a rerooted record whose one-key and two-key accounts are the signed change's. */
  const moveDeps = async () => {
    const rotation = storedRotation()
    const root = rotation.expectedKeys[0]!.key
    const source = rotation.builtOver.l2Address
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: { getAddress: () => ({ toString: () => source }) },
      authProvider: {},
    }
    const store = testRotations()
    await store.put(signedRecord({ phase: "rerooted" }))
    fakes.store = store
    const contractService = { contractService: true }
    openTestSession({ contractService: contractService })
    // The one-key account is the signed change's source; the two-key address is the plan's.
    const wallet = {
      deriveAccountAddress: async (_secret: unknown, set: string[]) => ({
        toString: () => (set.length === 1 ? source : PLAN.address),
      }),
      createObsidionAccount: async () => ({ getAddress: () => ({ toString: () => source }) }),
      node: {},
    } as unknown as ObsidionWallet
    return {
      deps: await buildBackupFlowDeps({
        owner: RECORD_OWNER,
        session: sessionWith(undefined, wallet),
      }),
      wallet,
      contractService,
    }
  }

  it("gives the root key the send's signal while it sends, and none after", async () => {
    let signalOf: (() => AbortSignal | undefined) | undefined
    const providerFor = h.auth.providerFor
    h.auth.providerFor = (passkey: { signal?: () => AbortSignal | undefined }) => {
      signalOf = passkey.signal
      return {}
    }
    const asked: (AbortSignal | undefined)[] = []
    fakes.tokenService.sendTokenSponsored.mockImplementationOnce(async () => {
      asked.push(signalOf?.())
    })
    try {
      const { deps } = await moveDeps()
      const screen = new AbortController()
      await deps.move.send("tok", 1n, vi.fn(), screen.signal)
      expect(asked).toEqual([screen.signal])
      expect(signalOf?.()).toBeUndefined()
    } finally {
      h.auth.providerFor = providerFor
    }
  })
})

describe("the move's paylinks", () => {
  const rotation = storedRotation()
  const source = rotation.builtOver.l2Address
  const link = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    flavor: "direct",
    txHash: `0x${id}`,
    secret: id,
    paylink: `https://wallet.example/link#frag-${id}`,
    fallbackSecret: "0x55",
    obsidionAccountAddress: source,
    untilClaimable: 4_000_000_000,
    refundableUntil: 4_000_000_000,
    amountAtomic: 10n ** 18n,
    ...over,
  })

  const linkDeps = async () => {
    const root = rotation.expectedKeys[0]!.key
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: { getAddress: () => ({ toString: () => source }) },
      authProvider: {},
    }
    const store = testRotations()
    await store.put(signedRecord({ phase: "rerooted" }))
    fakes.store = store
    openTestSession({ contractService: {} })
    const wallet = {
      deriveAccountAddress: async (_secret: unknown, set: string[]) => ({
        toString: () => (set.length === 1 ? source : PLAN.address),
      }),
      createObsidionAccount: async () => ({ getAddress: () => ({ toString: () => source }) }),
      node: {},
    } as unknown as ObsidionWallet
    return buildBackupFlowDeps({
      owner: RECORD_OWNER,
      session: sessionWith(undefined, wallet),
    })
  }

  it("lists the one-key account's open links, leaving out another account's and a create in flight", async () => {
    fakes.rows = [
      link("a"),
      link("b", { obsidionAccountAddress: `0x${"99".repeat(32)}` }),
      link("c", { operationId: "op-c" }),
      link("d", { isRefunded: true }),
    ]
    fakes.ops = [{ operationId: "op-c", state: "sent", txHash: "0xc" }]
    const deps = await linkDeps()
    expect(await deps.move.links()).toEqual(["frag-a"])
    fakes.ops = []
  })

  it("lists a link a recipient claimed while no checkpoint holds the claim, which a reorg can undo", async () => {
    fakes.rows = [
      link("a"),
      link("e", { isClaimed: true, claimedBy: "0xrecipient" }),
      link("f", { isClaimed: true, claimedBy: "0xrecipient" }),
    ]
    fakes.linkRefundable.mockImplementation(
      async (_deps: unknown, _row: unknown, fragment: unknown) =>
        fragment === "frag-e" ? ("spending" as never) : ("spent" as never),
    )
    try {
      const deps = await linkDeps()
      expect(await deps.move.links()).toEqual(["frag-a", "frag-e"])
    } finally {
      fakes.linkRefundable.mockImplementation(async () => "now" as const)
    }
  })

  it("finds a link by its secret after the history was rebuilt", async () => {
    fakes.rows = [link("a")]
    const deps = await linkDeps()
    const [fragment] = await deps.move.links()
    fakes.rows = [{ ...link("a"), timestamp: 1 }]
    await deps.move.refundable(fragment!)
    expect(fakes.linkRefundable.mock.calls.at(-1)?.slice(1)).toEqual([fakes.rows[0], "frag-a"])
  })

  it("takes a link back again after a reorg dropped its refund, once its record has lost the URL", async () => {
    fakes.rows = [link("a")]
    const deps = await linkDeps()
    const [fragment] = await deps.move.links()
    // An included refund drops the URL from the link.
    fakes.rows = [{ ...link("a"), paylink: undefined, isRefunded: true }]
    await deps.move.refundable(fragment!)
    expect(fakes.linkRefundable.mock.calls.at(-1)?.slice(1)).toEqual([fakes.rows[0], "frag-a"])
    await deps.move.refund(fragment!, vi.fn())
    expect(fakes.recover.mock.calls.at(-1)?.[1]).toBe("frag-a")
  })

  it("takes a link back as the one-key account, its hash checkpointed by the flow first", async () => {
    fakes.rows = [link("a")]
    let signalOf: (() => AbortSignal | undefined) | undefined
    const providerFor = h.auth.providerFor
    h.auth.providerFor = (passkey: { signal?: () => AbortSignal | undefined }) => {
      signalOf = passkey.signal
      return {}
    }
    const asked: (AbortSignal | undefined)[] = []
    fakes.recover.mockImplementationOnce(async () => {
      asked.push(signalOf?.())
      return "0xrefund"
    })
    try {
      const deps = await linkDeps()
      const onTxHash = vi.fn()
      const screen = new AbortController()
      await deps.move.refund("frag-a", onTxHash, screen.signal)
      const [paylinkDeps, fragment, onStage, passed] = fakes.recover.mock.calls.at(-1) as [
        { account: { getAddress(): unknown } },
        ...unknown[],
      ]
      expect(String(paylinkDeps.account.getAddress())).toBe(source)
      expect([fragment, onStage, passed]).toEqual(["frag-a", undefined, onTxHash])
      expect(asked).toEqual([screen.signal])
      expect(signalOf?.()).toBeUndefined()
      expect(await deps.move.refundable("frag-a")).toBe("now")
      expect(fakes.linkRefundable.mock.calls.at(-1)?.slice(1)).toEqual([fakes.rows[0], "frag-a"])
    } finally {
      h.auth.providerFor = providerFor
    }
  })
})

describe("the move's tokens", () => {
  /** Flow deps over a rerooted record, built with `savings` as the deployment's Savings read. */
  const flowDeps = async (savings: Promise<unknown>) => {
    fakes.savings = savings
    const rotation = storedRotation()
    const root = rotation.expectedKeys[0]!.key
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: { getAddress: () => rotation.builtOver.l2Address },
      authProvider: {},
    }
    const store = testRotations()
    await store.put(signedRecord({ phase: "rerooted" }))
    fakes.store = store
    fakes.client = { getBlockNumber: async () => 99n }
    openTestSession({ contractService: {} })
    const wallet = {
      deriveAccountAddress: async () => ({ toString: () => PLAN.address }),
      node: { getL1Constants: async () => ({ epochDuration: 32, slotDuration: 36 }) },
    } as unknown as ObsidionWallet
    return buildBackupFlowDeps({
      owner: RECORD_OWNER,
      session: sessionWith(undefined, wallet),
    })
  }

  it("builds while Savings is still being read, then moves both tokens, each under its own cap", async () => {
    let read!: (tuple: unknown) => void
    const deps = await flowDeps(new Promise((resolve) => (read = resolve)))
    const tokens = deps.move.tokens()
    read({ l2Token: SAVINGS_TOKEN })
    expect(await tokens).toEqual([MAIN_TOKEN, SAVINGS_TOKEN])
    expect(await deps.move.cap(MAIN_TOKEN)).toBe(2n * DAI)
    expect(await deps.move.cap(SAVINGS_TOKEN)).toBe(7n * DAI)
  })

  it("moves Main Account's token alone where the deployment has no Savings", async () => {
    const deps = await flowDeps(Promise.resolve(undefined))
    expect(await deps.move.tokens()).toEqual([MAIN_TOKEN])
  })

  it("plans the sends over Main Account's balance and Savings' shares, and the add's time over the rollup's epoch", async () => {
    // The suite's session outlives each test; a fresh one loads the identity this test saves.
    closeSession()
    openReading()
    await setIdentity({ address: storedRotation().builtOver.l2Address })
    const deps = await flowDeps(Promise.resolve({ l2Token: SAVINGS_TOKEN }))
    const held = { [MAIN_TOKEN]: 3n * DAI, [SAVINGS_TOKEN]: 10n * DAI }
    fakes.readSpendShape.mockImplementation(async (_wallet, { token }: { token: string }) => ({
      notes: [held[token]],
      depositTotal: 0n,
      balance: held[token],
    }))
    fakes.prepareBackupRotation.mockResolvedValue({
      rotation: { intent: { nonce: 1n }, sharedSecretSalt: word(3), deployArgs: {}, sipa: SIPA },
      builtOver: {},
      expectedKeys: [],
      implementation: addr(0x1e),
      add: {},
    })
    const breakdown = { withdrawalFee: 1n, proverTip: 0n, relayerTip: 1n }
    fakes.fundingAmount.mockResolvedValue({ amount: 10n, credited: 5n, breakdown })
    const record = signedRecord({ phase: "created" })
    const { plan } = await deps.prepare({
      ...record,
      backup: { ...record.backup, credentialId: "AQID" },
    })
    // Main's 3 under a cap of 2 is two sends; Savings' 10 under a cap of 7 is two more.
    expect(plan.moves).toBe(4)
    // No burns yet and no proofs this node can show: 600 s, 32 slots of 36 s, 900 s, 15 min.
    expect(plan.takesMs).toBe(3_552_000)
  })
})

describe("the funding", () => {
  const rotation = storedRotation()
  const source = rotation.builtOver.l2Address
  const entry = {
    attemptId: "attempt-1",
    localId: fundingLocalId("attempt-1"),
    sentAt: 5,
    session: "life-1",
    outcome: "pending" as const,
  }
  type Plan = typeof PLAN & { proverTip?: string }
  /** The session the deps run over, read back for what the burn persisted. */
  let open: Session
  /** What the burn owes the session's refuel task. */
  let owed: ReturnType<typeof vi.spyOn>
  /** The deployment the fee token bridge's tuple names. */
  const DEPLOYMENT = {
    portal: `0x${"b0".repeat(20)}`,
    l2Token: `0x${"2a".repeat(32)}`,
    executor: `0x${"e8".repeat(20)}`,
  }

  beforeEach(() => {
    // The suite's session outlives each test; the burn's operation needs one whose stores load.
    closeSession()
    Object.assign(openTestSession({ auth: fakeAuth() }).page.chain, READS)
    fakes.tokenService.exitToL1PrivateSponsored.mockClear()
  })

  /**
   * Flow deps over a published record with `plan`; the burn runs as an operation through the
   * gateway, over the session's stores.
   */
  const fundDeps = async (plan: Plan) => {
    const root = rotation.expectedKeys[0]!.key
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: { getAddress: () => ({ toString: () => source }) },
      authProvider: {},
    }
    const store = testRotations()
    await store.put(signedRecord({ phase: "published", plan }))
    fakes.store = store
    fakes.client = { getBlockNumber: async () => 99n, chain: { id: 11155111 } }
    fakes.tuple = {
      factory: addr(0xfa),
      token: addr(0xd4),
      portal: addr(0x90),
      operationExecutor: addr(0x0e),
      depositSubsidy: addr(0xd5),
      metadataRegistry: addr(0x3e),
      namePortal: addr(0x4e),
    }
    const wallet = {
      networkId: "0xnet",
      deriveAccountAddress: async (_secret: unknown, set: string[]) => ({
        toString: () => (set.length === 1 ? source : PLAN.address),
      }),
      createObsidionAccount: async () => ({ getAddress: () => ({ toString: () => source }) }),
      node: {},
    } as unknown as ObsidionWallet
    // The burn reads its wallet off the session it runs in.
    openTestSession({ contractService: {} })
    open = sessionWith(store, wallet)
    owed = vi.spyOn(open, "oweFpcRefuel")
    return {
      deps: await buildBackupFlowDeps({ owner: RECORD_OWNER, session: open }),
      store,
    }
  }
  const burnCall = () =>
    fakes.tokenService.exitToL1PrivateSponsored.mock.calls[0] as unknown as [
      { toString(): string },
      string,
      unknown,
      Record<string, unknown>,
    ]
  const persisted = () => open.withdrawals.get(entry.localId)

  it("burns the plan's tip, checkpoints the hash before the node takes it, and persists the record with the tip", async () => {
    const tip = (4n * DAI) / 10n
    const plan = {
      ...PLAN,
      fundingAmount: (BigInt(PLAN.fundingAmount) + tip).toString(),
      proverTip: tip.toString(),
    }
    const { deps, store } = await fundDeps(plan)
    const checkpointed: string[] = []
    let seeded: string | undefined
    fakes.tokenService.exitToL1PrivateSponsored.mockImplementationOnce(async (...args) => {
      const { onTxHash } = args[3] as { onTxHash: (txHash: string) => Promise<void> }
      await onTxHash(fakes.burnHash)
      seeded = (await persisted())?.phase
      return { txHash: fakes.burnHash, blockNumber: 7 }
    })
    await deps.fund((await store.get(RECORD_OWNER))!, entry, async (txHash) => {
      checkpointed.push(txHash)
    })
    expect(checkpointed).toEqual([fakes.burnHash])
    expect(seeded).toBe("submitting")
    const [to, amount, sponsor, options] = burnCall()
    expect(to.toString()).toBe(SIPA)
    expect(amount).toBe(plan.fundingAmount)
    expect(sponsor).toBe(fakes.sponsor)
    expect(options).toMatchObject({ proverTip: tip, useRawAmount: true })
    expect(await persisted()).toMatchObject({
      localId: entry.localId,
      intent: "backup",
      recipient: SIPA,
      amount: "2.4",
      rawAmount: plan.fundingAmount,
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      proverTip: tip.toString(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      deployment: DEPLOYMENT,
      phase: "l2_mined",
      l2TxHash: fakes.burnHash,
      blockNumber: 7,
    })
    const { operationId } = (await persisted())!
    expect(await open.operations.get(operationId!)).toMatchObject({
      flow: "withdraw",
      state: "settled",
    })
    // The sponsor's bookkeeping runs once the burn mined.
    expect(owed).toHaveBeenCalledTimes(1)
  })

  it("burns no tip for a plan without one, and persists no field for it", async () => {
    const { deps, store } = await fundDeps(PLAN)
    await deps.fund((await store.get(RECORD_OWNER))!, entry, vi.fn())
    const [, amount, , options] = burnCall()
    expect(amount).toBe(PLAN.fundingAmount)
    expect(options.proverTip).toBe(0n)
    const record = (await persisted())!
    expect(record).toMatchObject({ rawAmount: PLAN.fundingAmount, phase: "l2_mined" })
    expect("proverTip" in record).toBe(false)
  })

  it("quotes the sweep over what reaches the deposit address, the charges and stored tip off", async () => {
    const charges = { withdrawalFee: 10n, relayerTip: 5n, sweepTip: 7n, beneficiaryFee: 3n }
    fakes.fundingAmount.mockImplementation(
      async (_client: unknown, { proverTip }: { proverTip: bigint }) => ({
        amount: BigInt(PLAN.fundingAmount) + proverTip,
        credited: 0n,
        breakdown: { ...charges, proverTip, minCredited: 0n, margin: 0n },
      }),
    )
    // What the deposit address holds once the untipped funding is released, less its charges.
    const held = BigInt(PLAN.fundingAmount) - charges.withdrawalFee - charges.relayerTip
    const tipped = await fundDeps({
      ...PLAN,
      fundingAmount: (BigInt(PLAN.fundingAmount) + 400n).toString(),
      proverTip: "400",
    })
    try {
      fakes.sweepFloor = held
      expect(await tipped.deps.route(persistedRotation(rotation))).toBe("ok")
      // Quoted over the gross funding, or with the tip left on, the sweep would clear this floor.
      fakes.sweepFloor = held + 1n
      expect(await tipped.deps.route(persistedRotation(rotation))).toBe("route")
    } finally {
      fakes.sweepFloor = 0n
    }
  })

  it("answers whether one transfer of Main Account's token covers an amount, Savings left unread", async () => {
    fakes.savings = Promise.resolve({ l2Token: SAVINGS_TOKEN })
    fakes.readSpendShape
      .mockReset()
      .mockResolvedValue({ notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI })
    const { deps } = await fundDeps(PLAN)
    const fits = await deps.fundable()
    expect(fits(2n * DAI)).toBe(true)
    expect(fits(2n * DAI + 1n)).toBe(false)
    expect(fakes.readSpendShape).toHaveBeenCalledTimes(1)
    expect(fakes.readSpendShape).toHaveBeenCalledWith(
      expect.anything(),
      { token: MAIN_TOKEN },
      expect.anything(),
    )
    // Twenty notes of 0.1 DAI: the balance covers 2 DAI, the eighteen notes one transfer proves
    // do not.
    fakes.readSpendShape.mockResolvedValue({
      notes: Array.from({ length: 20 }, () => DAI / 10n),
      depositTotal: 0n,
      balance: 2n * DAI,
    })
    const fragmented = await deps.fundable()
    expect(fragmented((18n * DAI) / 10n)).toBe(true)
    expect(fragmented(2n * DAI)).toBe(false)
    fakes.readSpendShape.mockResolvedValue({ notes: [], depositTotal: 0n, balance: 0n })
    expect((await deps.fundable())(1n)).toBe(false)
    fakes.savings = Promise.resolve(undefined)
  })

  it("fails the fit read that does not answer in time", async () => {
    vi.useFakeTimers()
    try {
      fakes.readSpendShape.mockImplementation(() => new Promise(() => {}))
      const { deps } = await fundDeps(PLAN)
      const settled = deps.fundable().then(
        () => "answered",
        () => "failed",
      )
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await settled).toBe("failed")
    } finally {
      vi.useRealTimers()
      fakes.readSpendShape.mockResolvedValue({ notes: [], depositTotal: 0n, balance: 0n })
    }
  })
})

describe("the stranded deposit's recovery", () => {
  const tuple = { factory: addr(0xfa), token: addr(0xd4), portal: addr(0x90) }
  const secretKey = new Fr(5n)
  // The account the bootstrap key predicts under the factory the recovery checks.
  const owner = predictAccountAddressLocally(
    ACCOUNT_FACTORY as Address,
    deriveBootstrapKey(secretKey).address,
  )
  const record = signedRecord({
    owner,
    phase: "attention",
    attention: "stranded",
    suspended: "funded",
  })

  const setup = async (envFactory = ACCOUNT_FACTORY) => {
    const store = testRotations()
    await store.put(record)
    const root = storedRotation().expectedKeys[0]!.key
    fakes.store = store
    fakes.keys = {
      secretKey,
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: {},
      authProvider: {},
    }
    fakes.client = { getBlockNumber: async () => 99n }
    fakes.tuple = tuple
    fakes.envFactory = envFactory
    fakes.seed.mockReset().mockResolvedValue({ sipaAddress: SIPA })
    fakes.readStrandedToken.mockReset().mockResolvedValue({ balance: "1.4" })
    fakes.generations.mockReset()
    openTestSession({ contractService: {} })
    return buildBackupFlowDeps({
      owner,
      session: sessionWith(),
    })
  }

  it("reads the latest recovery at the deposit address", async () => {
    const deps = await setup()
    fakes.observe.mockResolvedValue({
      observed: new Map([
        [
          SIPA.toLowerCase(),
          { sweeps: [], outflows: [], recoveries: [{ txHash: word(1) }, { txHash: word(2) }] },
        ],
      ]),
      strays: [],
    })
    expect(await deps.l1.recovery(SIPA, 50)).toBe(word(2))
    expect(fakes.observe).toHaveBeenCalledWith(fakes.client, {
      portals: [tuple.portal],
      tokens: [tuple.token],
      subjects: [
        {
          address: SIPA,
          commitment: storedRotation().intent.recipientCommitment,
          fromBlock: 50n,
          inflows: false,
        },
      ],
      head: 99n,
    })
    fakes.observe.mockResolvedValue({ observed: new Map(), strays: [] })
    await expect(deps.l1.recovery(SIPA, 50)).rejects.toThrow("did not complete")
  })

  it("reads a transaction's block from its receipt: none before it has one, and other failures throw", async () => {
    const deps = await setup()
    const getTransactionReceipt = vi.fn(async () => ({ blockNumber: 120n, blockHash: word(3) }))
    Object.assign(fakes.client as object, { getTransactionReceipt })
    expect(await deps.l1.txBlock(word(1))).toEqual({ blockNumber: 120, blockHash: word(3) })
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: word(1) })
    getTransactionReceipt.mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: word(1) }),
    )
    expect(await deps.l1.txBlock(word(1))).toBeUndefined()
    const down = new Error()
    getTransactionReceipt.mockRejectedValueOnce(down)
    await expect(deps.l1.txBlock(word(1))).rejects.toBe(down)
  })

  it("reads the settled block a fixed depth behind the tip, floored at genesis", async () => {
    const deps = await setup()
    const getBlockNumber = vi.fn(async () => 100n)
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: word(4),
    }))
    Object.assign(fakes.client as object, { getBlockNumber, getBlock })
    expect(await deps.l1.settledBlock()).toEqual({ number: 97, hash: word(4) })
    expect(getBlock).toHaveBeenLastCalledWith({ blockNumber: 97n })
    getBlockNumber.mockResolvedValue(2n)
    expect(await deps.l1.settledBlock()).toEqual({ number: 0, hash: word(4) })
  })

  it("counts a block settled while its hash holds at the settled depth, never on a failed read", async () => {
    const deps = await setup()
    const getBlockNumber = vi.fn(async () => 100n)
    const getBlock = vi.fn(async () => ({ hash: word(3) }))
    Object.assign(fakes.client as object, { getBlockNumber, getBlock })
    expect(await deps.l1.isSettled({ blockNumber: 97, blockHash: word(3) })).toBe(true)
    expect(await deps.l1.isSettled({ blockNumber: 98, blockHash: word(3) })).toBe(false)
    expect(await deps.l1.isSettled({ blockNumber: 97, blockHash: word(5) })).toBe(false)
    const down = new Error()
    getBlockNumber.mockRejectedValueOnce(down)
    await expect(deps.l1.isSettled({ blockNumber: 97, blockHash: word(3) })).rejects.toBe(down)
  })

  it("reads the deposit balance and the portal's release at the settled block's number", async () => {
    const deps = await setup()
    const readContract = vi.fn(async () => 7n)
    const getBlock = vi.fn(async () => ({ number: 97n, hash: word(4) }))
    Object.assign(fakes.client as object, {
      getBlockNumber: async () => 100n,
      getBlock,
      readContract,
    })
    const at = { number: 97, hash: word(4) }
    expect(await deps.l1.sipaBalance(SIPA, at)).toBe(7n)
    expect(readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "balanceOf", blockNumber: 97n }),
    )
    await deps.l1.sipaBalance(SIPA, "latest")
    expect(readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "balanceOf", blockTag: "latest" }),
    )
    await deps.l1.sipaBalance(SIPA)
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: 97n })
    expect(readContract).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 97n }))
    readContract.mockResolvedValueOnce(true as never)
    expect(await deps.l1.releaseSettled(word(7), at)).toBe(true)
    expect(readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "$isWithdrawalSpent", blockNumber: 97n }),
    )
  })

  it("gives an uncoded read the generic words, and passes an empty address through", async () => {
    const deps = await setup()
    fakes.readStrandedToken.mockRejectedValueOnce(new Error("Switch networks and try again."))
    const failed = deps.strandedDeposit(record)
    await expect(failed).rejects.toBeInstanceOf(DepositReadError)
    await expect(failed).rejects.toThrow(catalogCopy.unknown)
    fakes.readStrandedToken.mockRejectedValueOnce(new EmptyDepositError())
    await expect(deps.strandedDeposit(record)).rejects.toBeInstanceOf(EmptyDepositError)
    fakes.seed.mockRejectedValueOnce(new Error("nothing signed to publish"))
    await expect(deps.strandedDeposit(record)).rejects.not.toBeInstanceOf(DepositReadError)
  })

  it("names the factory of an account an earlier generation made from the deployment's catalog, once", async () => {
    const deps = await setup(addr(0x01))
    fakes.generations.mockResolvedValue({
      catalog: [{ accountFactory: addr(0x02) }, { accountFactory: ACCOUNT_FACTORY }],
    })
    await deps.strandedDeposit(record)
    await deps.strandedDeposit(record)
    expect(fakes.seed).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountFactory: ACCOUNT_FACTORY }),
    )
    expect(fakes.generations).toHaveBeenCalledTimes(1)

    const missing = await setup(addr(0x01))
    fakes.generations.mockResolvedValue({ catalog: [{ accountFactory: addr(0x02) }] })
    await expect(missing.strandedDeposit(record)).rejects.toThrow("no account factory")
    await expect(missing.strandedDeposit(record)).rejects.toThrow("no account factory")
    expect(fakes.generations).toHaveBeenCalledTimes(2)
  })
})

describe("the re-root", () => {
  it("points the identity at the two-key account, keeping its tag", async () => {
    const source = storedRotation().builtOver.l2Address
    await seedDeviceKeys({ storageId: "rotating", credentialId: "root-credential" })
    Object.assign(openTestSession({ auth: fakeAuth() }).page.chain, READS)
    await setIdentity({ handle: "taga", address: source })
    const root = storedRotation().expectedKeys[0]!.key
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: { getAddress: () => ({ toString: () => source }) },
      authProvider: {},
    }
    fakes.store = testRotations()
    openTestSession({ contractService: {} })
    Object.assign(h.auth, {
      accountRecord: async () => undefined,
      stageRecoveryMetadata: async () => {},
      recordLearned: async () => {},
      holdsSession: () => () => true,
      commitSecret: async () => 1,
      sessionHeld: () => true,
    })
    const twoKey = { toString: () => PLAN.address }
    const wallet = {
      deriveAccountAddress: async () => twoKey,
      createObsidionAccount: async () => ({
        getAddress: () => twoKey,
        getCompleteAddress: () => ({ toString: () => `0x${"2b".repeat(288)}` }),
      }),
    } as unknown as ObsidionWallet
    const deps = await buildBackupFlowDeps({
      owner: RECORD_OWNER,
      session: sessionWith(undefined, wallet),
    })

    await deps.reroot(signedRecord(), async () => {})

    expect(await savedIdentity()).toMatchObject({ handle: "taga", address: PLAN.address })
  })
})
