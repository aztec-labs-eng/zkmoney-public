import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { recoverMessageAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { campaignTagClaimedPreimage } from "@obsidion/core/constants"

import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import type { StorageLock } from "../../../src/core/storages/adapter"
import {
  CAMPAIGN_CLAIM_NOTICE_TTL_MS,
  CampaignClaimNoticeStore,
  deliverCampaignClaimNotices,
  sendCampaignClaimNotice,
  type CampaignClaimSigner,
} from "../../../src/core/services/registration"

const CAMPAIGN = "https://launch.test/"
const L2 = "0x" + "Cd".repeat(32)
const OTHER_L2 = "0x" + "ef".repeat(32)
const SIGNER = privateKeyToAccount(`0x${"11".repeat(32)}`)
const T0 = 1_790_000_000_000

/**
 * The wire contract with launch-campaign-web: its tests/reminders.test.ts verifies this exact body
 * through the real route. Signatures are deterministic, so either side drifting fails its test.
 */
const CONTRACT_BODY = {
  address: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
  handle: "alice",
  timestamp: 1_790_000_000,
  signature:
    "0xbf0270faa9edbc5b2ebf0727e6bc7acdad4640a6e57a824d905569f0f6c201a01b28f60f6848c6624e1c8014f383007d5e2048e15e381e2200bf723ffdaf41d51c",
}

/** A same-realm stand-in for the wallet's Web Lock. */
function queueLock(): StorageLock {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }
}

let now: number
let calls: { url: string; body: Record<string, unknown> }[]
let answers: (number | Error)[]
let lock: StorageLock
let store: CampaignClaimNoticeStore

beforeEach(() => {
  now = T0
  calls = []
  answers = []
  lock = queueLock()
  store = new CampaignClaimNoticeStore(new InMemoryStorageAdapter(), lock)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      const answer = answers.shift() ?? 200
      if (answer instanceof Error) throw answer
      return new Response(null, { status: answer })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const pass = (
  signerFor: (l2: string) => Promise<CampaignClaimSigner | null> = async () => SIGNER,
) => deliverCampaignClaimNotices({ store, campaignUrl: CAMPAIGN, signerFor, now: () => now })

describe("sendCampaignClaimNotice", () => {
  it("posts the body the campaign verifies", async () => {
    expect(await sendCampaignClaimNotice(CAMPAIGN, SIGNER, "alice", () => T0)).toBe("delivered")
    expect(calls).toEqual([
      { url: "https://launch.test/api/registration/claimed", body: CONTRACT_BODY },
    ])
    const recovered = await recoverMessageAddress({
      message: campaignTagClaimedPreimage(SIGNER.address, "alice", CONTRACT_BODY.timestamp),
      signature: CONTRACT_BODY.signature as `0x${string}`,
    })
    expect(recovered).toBe(SIGNER.address)
  })

  it("sorts the campaign's answers into delivered, refused and retry", async () => {
    const send = () => sendCampaignClaimNotice(CAMPAIGN, SIGNER, "alice", () => T0)
    for (const [answer, expected] of [
      [204, "delivered"],
      [400, "refused"],
      [404, "refused"],
      [409, "refused"],
      [401, "retry"],
      [429, "retry"],
      [503, "retry"],
      [new TypeError("Failed to fetch"), "retry"],
    ] as const) {
      answers.push(answer)
      expect(await send(), String(answer)).toBe(expected)
    }
  })
})

describe("deliverCampaignClaimNotices", () => {
  it("delivers an owed notice once and forgets it", async () => {
    await store.owe({ l2Address: L2, tag: "alice" }, now)
    expect(await pass()).toBe(0)
    expect(calls.map((c) => c.body.handle)).toEqual(["alice"])
    expect(await store.list()).toEqual([])
    expect(await pass()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it("owing again keeps the backoff; the same account's other tag replaces it", async () => {
    await store.owe({ l2Address: L2, tag: "alice" }, now)
    answers.push(503)
    await pass()
    await store.owe({ l2Address: L2.toLowerCase(), tag: "alice" }, now + 1)
    expect(await store.list()).toMatchObject([{ tag: "alice", attempts: 1 }])
    await store.owe({ l2Address: L2, tag: "bob" }, now + 2)
    expect(await store.list()).toEqual([
      { l2Address: L2.toLowerCase(), tag: "bob", owedAt: now + 2, attempts: 0 },
    ])
  })

  it("waits for a signer that owns the account, without spending an attempt", async () => {
    await store.owe({ l2Address: L2, tag: "alice" }, now)
    const signerFor = vi.fn(async (l2: string) => (l2 === OTHER_L2 ? SIGNER : null))
    expect(await pass(signerFor)).toBe(1)
    expect(signerFor).toHaveBeenCalledWith(L2.toLowerCase())
    expect(await pass(async () => Promise.reject(new Error("locked")))).toBe(1)
    expect(calls).toEqual([])
    expect(await store.list()).toMatchObject([{ attempts: 0 }])
    expect(await pass()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it("backs off a failed delivery, doubling up to an hour, and retries it when due", async () => {
    await store.owe({ l2Address: L2, tag: "alice" }, now)
    answers.push(503)
    expect(await pass()).toBe(1)
    expect(await store.list()).toMatchObject([{ attempts: 1, nextAttemptAt: T0 + 30_000 }])

    now = T0 + 29_999
    expect(await pass()).toBe(1)
    expect(calls).toHaveLength(1)

    const delays: number[] = []
    for (let i = 0; i < 9; i++) {
      const [notice] = await store.list()
      now = notice.nextAttemptAt!
      answers.push(new TypeError("Failed to fetch"))
      await pass()
      delays.push((await store.list())[0].nextAttemptAt! - now)
    }
    expect(delays).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600, 3600].map((s) => s * 1000))

    now = (await store.list())[0].nextAttemptAt!
    expect(await pass()).toBe(0)
    expect(await store.list()).toEqual([])
  })

  it("drops a refused notice without retrying it", async () => {
    await store.owe({ l2Address: L2, tag: "alice" }, now)
    answers.push(409)
    expect(await pass()).toBe(0)
    expect(await store.list()).toEqual([])
  })

  it("drops a notice older than any reservation it could stop", async () => {
    await store.owe({ l2Address: L2, tag: "alice" }, now)
    now += CAMPAIGN_CLAIM_NOTICE_TTL_MS + 1
    expect(await pass()).toBe(0)
    expect(calls).toEqual([])
    expect(await store.list()).toEqual([])
  })

  it("keeps state in storage, so another store over it sees the same notices", async () => {
    const storage = new InMemoryStorageAdapter()
    await new CampaignClaimNoticeStore(storage, lock).owe({ l2Address: L2, tag: "alice" }, now)
    store = new CampaignClaimNoticeStore(storage, lock)
    answers.push(503)
    await pass()
    expect(await new CampaignClaimNoticeStore(storage, lock).list()).toMatchObject([
      { attempts: 1 },
    ])
  })

  it("stores sharing storage and lock never drop each other's concurrent writes", async () => {
    const storage = new InMemoryStorageAdapter()
    const [a, b] = [
      new CampaignClaimNoticeStore(storage, lock),
      new CampaignClaimNoticeStore(storage, lock),
    ]
    await a.owe({ l2Address: OTHER_L2, tag: "carol" }, now)
    await Promise.all([
      a.owe({ l2Address: L2, tag: "alice" }, now),
      b.defer({ l2Address: OTHER_L2, tag: "carol" }, now),
    ])
    expect(await a.list()).toMatchObject([
      { l2Address: OTHER_L2, tag: "carol", attempts: 1 },
      { l2Address: L2.toLowerCase(), tag: "alice", attempts: 0 },
    ])
  })

  it("a notice owed for another tag while one is on the wire outlives that delivery", async () => {
    await store.owe({ l2Address: L2, tag: "alice" }, now)
    vi.stubGlobal("fetch", async () => {
      await store.owe({ l2Address: L2, tag: "bob" }, now + 1)
      return new Response(null, { status: 200 })
    })
    expect(await pass()).toBe(0)
    expect(await store.list()).toMatchObject([{ tag: "bob", attempts: 0 }])
  })
})
