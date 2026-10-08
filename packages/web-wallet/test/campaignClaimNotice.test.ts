/**
 * The campaign stops a reserved tag's expiry reminder once the wallet reports the claim. The report
 * is owed the moment the detection tick confirms the name on chain, whether or not the session is
 * unlocked, and the delivery loop sends it with the bootstrap key of the unlocked account that owns
 * it, retrying a failed send across reloads. Only a confirmed outcome owes it, and nothing about it
 * can fail the registration. The notices live in the rollup's wallet database, in the owing
 * account's namespace, which only the active tab holds open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { recoverMessageAddress, zeroAddress, type Address, type Hex } from "viem"
import { campaignTagClaimedPreimage } from "@obsidion/core/constants"
import {
  CAMPAIGN_CLAIM_NOTICE_STORAGE_KEY,
  NameClaimStore,
  PendingRegistrationStore,
  deriveBootstrapKey,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  config: { l1ChainId: 11155111, campaignUrl: "https://launch.test" },
  secretKey: undefined as { toString(): string } | undefined,
  sessionAddress: "",
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readNameClaimLog: vi.fn(async () => null),
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn() }))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => h.config,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    getSecretKey: async () => h.secretKey,
    getAuthProvider: async () =>
      h.secretKey
        ? { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] }
        : undefined,
  }),
}))
// Only the re-broadcast half of registrationResume needs it, and it drags the Aztec stack in.
vi.mock("../src/features/onboarding/oxideOnboarding", () => ({ buildRetrySignDeps: vi.fn() }))

import { runDetectionTick, type WebDetectionDeps } from "../src/features/onboarding/webRegistration"
import { WebStorageAdapter } from "../src/platform/storage/WebStorageAdapter"
import { setActiveStorageId } from "../src/platform/storage/activeStorage"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../src/platform/storage/walletStorage"
import { loadWalletIdentity, saveWalletIdentity } from "../src/features/identity/walletIdentity"
import { sandboxProfile } from "./fixtures/sandboxProfile"
import { resetModulesAsActiveTab } from "./support/activeTab"
import { testWalletDbs } from "./support/fakeWalletDb"

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
const OTHER = "0x00000000000000000000000000000000000000bb" as Address
const NAME_HASH = `0x${"77".repeat(32)}` as Hex
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MSK = { toString: () => `0x${"0a".repeat(32)}` }
const BOOTSTRAP = deriveBootstrapKey(MSK).address
const T0 = 1_790_000_000_000
const RECHECK_MS = 30_000
const dbs = testWalletDbs()
const openSaved = () => openWalletStore(sandboxProfile().shared.rollupVersion, { persistent: true })

/** The wallet as the delivery loop sees it: it derives the unlocked account's address. */
const wallet = {
  createObsidionAccount: async () => ({ getAddress: () => ({ toString: () => h.sessionAddress }) }),
}

let posts: {
  url: string
  body: { address: string; handle: string; timestamp: number; signature: Hex }
}[]
let answers: (number | "offline")[]
let stops: (() => void)[]

function freshStore(): PendingRegistrationStore {
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  NameClaimStore.resetForTests()
  NameClaimStore.get(new WebStorageAdapter())
  return PendingRegistrationStore.get(new WebStorageAdapter())
}

async function openRecord(over: Partial<PendingRegistrationRecord> = {}) {
  const store = freshStore()
  await store.upsert(
    ACCOUNT,
    {},
    {
      tag: "alice",
      nameHash: NAME_HASH,
      l2Address: L2_ADDRESS,
      l1ChainId: 11155111,
      sipaAddress: "0x00000000000000000000000000000000000000c3",
      fee: "1",
      depositToken: "0x00000000000000000000000000000000000000d4",
      broadcast: true,
      phase: "funded",
      fundedAt: T0 - 60_000,
      retries: 0,
      startTime: T0 - 120_000,
      ...over,
    },
  )
  saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: T0, pending: true })
  return store
}

/** A boot or loop tick against an L1 whose Registry answers with `l1`. */
function tick(store: PendingRegistrationStore, l1: Record<string, unknown> = {}) {
  const deps = {
    env: { registry: OTHER, factory: OTHER, ensDomain: "oxidestaging.eth", l1ChainId: 11155111 },
    l1: {
      readUserAddress: vi.fn(async () => ACCOUNT),
      readNameOf: vi.fn(async () => `0x${"00".repeat(32)}`),
      readUserRecord: vi.fn(async () => ({ l2Address: L2_ADDRESS })),
      ...l1,
    },
    deposits: {
      readBalance: vi.fn(async () => 0n),
      readSweeps: vi.fn(async () => []),
      floor: vi.fn(async () => 0n),
    },
    pendingStore: store,
    publicClient: {},
    resolveLocalTag: async () => null,
  } as unknown as WebDetectionDeps
  return runDetectionTick(deps)
}

/** One page load's delivery loop, as App mounts it; the modules are fresh, only storage carries over. */
async function mountLoop() {
  const { startCampaignClaimNoticeLoop } = await import(
    "../src/features/identity/campaignClaimNotice"
  )
  const { campaignClaimSigner } = await import("../src/features/onboarding/registrationResume")
  stops.push(startCampaignClaimNoticeLoop(campaignClaimSigner(wallet as never)))
}

/** The page goes away, closing its wallet database, and the next one opens what it saved. */
async function reload() {
  for (const stop of stops.splice(0)) stop()
  await closeWalletStore()
  await resetModulesAsActiveTab()
  await openSaved()
  await mountLoop()
}

/** The notices owed in `storageId`'s namespace (none: before any account). */
const owed = (storageId?: string) =>
  JSON.parse(
    walletStorage.getItem(
      `obsidion.${storageId ? `${storageId}.` : ""}${CAMPAIGN_CLAIM_NOTICE_STORAGE_KEY}`,
    ) ?? "{}",
  )
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "Date"] })
  localStorage.clear()
  await closeWalletStore()
  await openSaved()
  h.config = { l1ChainId: 11155111, campaignUrl: "https://launch.test" }
  h.secretKey = MSK
  h.sessionAddress = L2_ADDRESS
  posts = []
  answers = []
  stops = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      const answer = answers.shift() ?? 200
      if (answer === "offline") throw new TypeError("Failed to fetch")
      return new Response(null, { status: answer })
    }),
  )
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("the campaign claim notice", () => {
  it("a confirmed registration reports the claim, signed by the account's bootstrap key", async () => {
    const store = await openRecord()
    await mountLoop()
    expect(await tick(store)).toBe("confirmed")
    await settle()

    expect(posts).toHaveLength(1)
    const [{ url, body }] = posts
    expect(url).toBe("https://launch.test/api/registration/claimed")
    expect(body).toMatchObject({ address: BOOTSTRAP, handle: "alice", timestamp: T0 / 1000 })
    const signer = await recoverMessageAddress({
      message: campaignTagClaimedPreimage(body.address, body.handle, body.timestamp),
      signature: body.signature,
    })
    expect(signer).toBe(BOOTSTRAP)
    expect(owed()).toEqual({})

    await vi.advanceTimersByTimeAsync(10 * RECHECK_MS)
    expect(posts).toHaveLength(1)
  })

  it("a failed report is retried after its backoff, and again after a reload", async () => {
    const store = await openRecord()
    await mountLoop()
    answers.push(503, "offline")
    expect(await tick(store)).toBe("confirmed")
    await settle()
    expect(posts).toHaveLength(1)
    expect(owed()[L2_ADDRESS]).toMatchObject({
      tag: "alice",
      attempts: 1,
      nextAttemptAt: T0 + 30_000,
    })

    // In session: the loop's recheck sends it again once the backoff ran out.
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(posts).toHaveLength(2)
    expect(owed()[L2_ADDRESS]).toMatchObject({ attempts: 2, nextAttemptAt: T0 + 30_000 + 60_000 })

    // A reload inside the backoff sends nothing; the next page's loop sends it once it is due.
    await reload()
    await settle()
    expect(posts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(posts).toHaveLength(3)
    expect(posts[2].body).toMatchObject({ address: BOOTSTRAP, handle: "alice" })
    expect(owed()).toEqual({})
  })

  it("confirmed while locked, it waits for the unlock and survives the reload in between", async () => {
    h.secretKey = undefined
    const store = await openRecord()
    // The boot tick runs before the wallet is up, with no loop mounted.
    expect(await tick(store)).toBe("confirmed")
    await settle()
    expect(owed()[L2_ADDRESS]).toMatchObject({ tag: "alice", attempts: 0 })

    await reload()
    await vi.advanceTimersByTimeAsync(3 * RECHECK_MS)
    expect(posts).toEqual([])
    expect(owed()[L2_ADDRESS]).toMatchObject({ attempts: 0 })

    h.secretKey = MSK
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(posts.map((p) => p.body.address)).toEqual([BOOTSTRAP])
    expect(owed()).toEqual({})
  })

  it("never signs with a session that unlocks another account", async () => {
    const store = await openRecord()
    h.sessionAddress = `0x${"ee".repeat(32)}`
    await mountLoop()
    await tick(store)
    await vi.advanceTimersByTimeAsync(3 * RECHECK_MS)
    expect(posts).toEqual([])
    expect(owed()[L2_ADDRESS]).toMatchObject({ tag: "alice" })
  })

  it("only a confirmed outcome owes it: a lost race, a foreign name or a pending claim do not", async () => {
    const outcomes: Record<string, Record<string, unknown>> = {
      taken: { readUserAddress: vi.fn(async () => OTHER) },
      needs_recovery: {
        readUserAddress: vi.fn(async () => zeroAddress),
        readNameOf: vi.fn(async () => `0x${"99".repeat(32)}`),
      },
      pending: { readUserAddress: vi.fn(async () => zeroAddress) },
    }
    for (const [expected, l1] of Object.entries(outcomes)) {
      await closeWalletStore()
      dbs.reset()
      await openSaved()
      const store = await openRecord()
      await mountLoop()
      expect(await tick(store, l1)).toBe(expected)
      await vi.advanceTimersByTimeAsync(RECHECK_MS)
      expect(owed(), expected).toEqual({})
    }
    expect(posts).toEqual([])
  })

  it("an account's notice is neither read nor sent while another account's namespace is active", async () => {
    h.secretKey = undefined
    setActiveStorageId("account-a")
    await walletStorage.flush()
    const store = await openRecord()
    expect(await tick(store)).toBe("confirmed")
    await settle()
    expect(owed("account-a")[L2_ADDRESS]).toMatchObject({ tag: "alice" })

    setActiveStorageId("account-b")
    await walletStorage.flush()
    h.secretKey = MSK
    await mountLoop()
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(posts).toEqual([])
    expect(owed("account-b")).toEqual({})

    setActiveStorageId("account-a")
    await walletStorage.flush()
    await reload()
    await settle()
    expect(posts.map((p) => p.body.address)).toEqual([BOOTSTRAP])
    expect(owed("account-a")).toEqual({})
  })

  it("a notice that fails to save leaves the registration confirmed and owes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    dbs.onApply = (_, ops) => {
      if (ops.some(([key]) => key.endsWith(CAMPAIGN_CLAIM_NOTICE_STORAGE_KEY))) {
        throw new Error("disk full")
      }
    }
    const store = await openRecord()
    await mountLoop()
    expect(await tick(store)).toBe("confirmed")
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(warn).toHaveBeenCalledWith(
      "[campaignClaimNotice] owing the claim notice failed:",
      expect.objectContaining({ message: "disk full" }),
    )
    expect(owed()).toEqual({})
    expect(posts).toEqual([])
    expect(store.get(ACCOUNT)?.phase).toBe("confirmed")
    warn.mockRestore()
  })

  it("a tab whose database closed on a takeover sends nothing; the next active tab sends it", async () => {
    h.secretKey = undefined
    const store = await openRecord()
    await mountLoop()
    expect(await tick(store)).toBe("confirmed")
    await settle()
    expect(owed()[L2_ADDRESS]).toMatchObject({ attempts: 0 })

    // Taken over: the page closes its wallet database, and its loop runs until the page goes.
    await closeWalletStore()
    h.secretKey = MSK
    await vi.advanceTimersByTimeAsync(3 * RECHECK_MS)
    expect(posts).toEqual([])

    await reload()
    await settle()
    expect(posts.map((p) => p.body.address)).toEqual([BOOTSTRAP])
    expect(owed()).toEqual({})
  })

  it("a campaign that refuses the report is not asked again", async () => {
    const store = await openRecord()
    await mountLoop()
    answers.push(404)
    await tick(store)
    await vi.advanceTimersByTimeAsync(10 * RECHECK_MS)
    expect(posts).toHaveLength(1)
    expect(owed()).toEqual({})
  })

  it("a campaign outage leaves the registration confirmed", async () => {
    const store = await openRecord()
    await mountLoop()
    answers.push("offline", "offline", "offline")
    expect(await tick(store)).toBe("confirmed")
    await vi.advanceTimersByTimeAsync(4 * RECHECK_MS)
    expect(posts.length).toBeGreaterThan(1)
    expect(store.get(ACCOUNT)?.phase).toBe("confirmed")
    expect(loadWalletIdentity()).toMatchObject({ handle: "alice" })
    expect(loadWalletIdentity()?.pending).toBeUndefined()
  })

  it("a wallet with no campaign owes nothing", async () => {
    h.config = { ...h.config, campaignUrl: "" }
    const store = await openRecord()
    await mountLoop()
    expect(await tick(store)).toBe("confirmed")
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(owed()).toEqual({})
    expect(posts).toEqual([])
  })
})
