// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
/**
 * Home's claim sheet for one stashed link: the review's split, and the flow over the session's
 * records with the link's reads and the claim standing in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadRecords, TxInFlightError, type RegistrationTerms } from "@obsidion/front-core"
import {
  CLAIM_IO,
  openClaimFlow,
  reviewQuote,
  type ClaimInputs,
} from "../../../../src/features/paylink/ClaimLinkSheet/claimFlow"
import { peekClaimStash, stashClaimLink } from "../../../../src/features/paylink/claimStash"
import { tabStash } from "../../../../src/platform/storage/tabStash"
import { linkIdentity } from "../../../../src/features/paylink/linkIdentity"
import type { PaymentLink } from "../../../../src/features/paylink/types"
import { subscribeErrorModal } from "../../../../src/errors/errorModal"
import { closeSession } from "../../../../src/session/session"
import { openTestSession } from "../../../support/session"
import {
  L2_ADDRESS,
  SIPA,
  pendingRecord,
  seedRegistration,
} from "../../../support/registrationFixtures"
import { PAYLINK_FRAGMENT } from "../../../fixtures/scanPayloads"

const fresh = (over: Partial<PaymentLink> = {}): PaymentLink => ({
  url: "u",
  fragment: PAYLINK_FRAGMENT,
  status: "unclaimed",
  flavor: "direct",
  amount: "20",
  claimableFrom: 100,
  ...over,
})

describe("a signup review's split", () => {
  const schedule = { fee: 1_000n, min: 0n }
  const terms: RegistrationTerms = { deadline: 1, proverTip: "40", withdrawalFee: "70" }
  const quote = (over: Partial<Parameters<typeof reviewQuote>[0]>) =>
    reviewQuote({ quoting: false, live: {}, terms, schedule, paylink: 10_000n, ...over })

  it("prices every row off the committed terms when it mounts after the claim was sent", () => {
    expect(quote({})).toMatchObject({ provingFee: 40n, paylink: 10_000n })
    expect(quote({})).toEqual(quote({ live: { tip: 1n, fee: 2n } }))
  })

  it("quotes live before the claim", () => {
    const live = quote({ quoting: true, live: { tip: 5n, fee: 9n } })
    expect(live?.provingFee).toBe(5n)
    expect(live?.networkFee).not.toBe(quote({})?.networkFee)
    expect(quote({ quoting: true, live: { tip: 5n } })).toBeUndefined()
  })

  it("prices an older build's terms, which carry no fee, off the live fee", () => {
    const older = { deadline: 1, proverTip: "40" }
    expect(quote({ terms: older })).toBeUndefined()
    expect(quote({ terms: older, live: { fee: 70n } })).toEqual(quote({}))
  })
})

const tab = new Map<string, string>()
vi.stubGlobal("location", { origin: "https://wallet.test" })
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => tab.get(key) ?? null,
  setItem: (key: string, value: string) => void tab.set(key, value),
  removeItem: (key: string) => void tab.delete(key),
})

/** This tab read the link before: its seed's status stands only until a read here answers. */
const readEarlier = () =>
  tab.set(`obsidion.link-read:${linkIdentity(PAYLINK_FRAGMENT)}`, JSON.stringify(fresh()))

const ticket = (over: Partial<RegistrationTerms> = {}): RegistrationTerms => ({
  deadline: Math.floor(Date.now() / 1000) + 3_600,
  fee: "1",
  minDeposit: "0",
  paylinkFunded: true,
  paylinkId: linkIdentity(PAYLINK_FRAGMENT),
  ...over,
})

const ends: AbortController[] = []
beforeEach(() => {
  tab.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  const account = { getAddress: () => ({ toString: () => L2_ADDRESS }) }
  const wallet = { networkId: "0xroll", node: {} }
  openTestSession({ wallet, account, contractService: {}, token: {}, teeSigner: {} })
})
afterEach(() => {
  for (const end of ends.splice(0)) end.abort()
  closeSession()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The claim's burn to the signup's address, in `phase`. */
const burn = (phase: "submitting" | "done" | "failed") =>
  openTestSession().withdrawals.create({
    networkId: "0xnet",
    localId: `w-${phase}`,
    recipient: SIPA,
    recipientProvenance: "saved-recipient",
    amount: "5",
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    phase,
    startTime: 1,
  })

const noTick = () => {}

/** The flow over the test session, with the reads and the claim held by the test. */
async function sheet(over: Partial<ClaimInputs> = {}, registration?: RegistrationTerms) {
  stashClaimLink(tabStash, PAYLINK_FRAGMENT)
  if (registration) await seedRegistration(pendingRecord({ terms: registration }))
  await openTestSession().withdrawals.ready
  await loadRecords(openTestSession().registrations.view)
  const reads: {
    answer: (link: PaymentLink) => void
    settle: (noteRead: boolean) => void
    tick: (seconds: number) => void
    watches: number
  } = { answer: () => {}, settle: () => {}, tick: noTick, watches: 0 }
  const claim: { end: (e?: unknown) => void; calls: number } = { end: () => {}, calls: 0 }
  const released: string[] = []
  const inputs: ClaimInputs = {
    requested: false,
    onDone: vi.fn(),
    claimDeps: {} as never,
    chainNow: 1_000,
    detecting: false,
    funding: null,
    ...over,
  }
  const flow = openClaimFlow(openTestSession(), PAYLINK_FRAGMENT, () => inputs, {
    ...CLAIM_IO,
    watch: (_deps, _fragment, onLink, _onError, onSettled) => {
      reads.watches++
      reads.answer = onLink
      reads.settle = (noteRead) => onSettled?.(noteRead)
      return () => {}
    },
    claim: () =>
      new Promise<string>((resolve, reject) => {
        claim.calls++
        claim.end = (e) => (e === undefined ? resolve("0xclaim") : reject(e))
      }),
    opened: () => {},
    chainSeconds: (_node, notify) => {
      reads.tick = notify
      return () => {}
    },
    release: (_session, record) => void released.push(record.sipaAddress),
  })
  const ended = new AbortController()
  ends.push(ended)
  flow.start(ended.signal)
  const claims = () => openTestSession().claims.state.get()
  return { flow, reads, claim, released, inputs, claims, end: () => ended.abort() }
}

describe("Home's claim sheet", () => {
  it("offers the claim once a read here answers, then hands off as the claim succeeds", async () => {
    const h = await sheet()
    expect(h.flow.claim(false, Promise.resolve())).toBe(false)
    h.reads.answer(fresh())
    expect(h.flow.claim(false, Promise.resolve())).toBe(true)
    h.claim.end()
    await vi.waitFor(() => expect(h.inputs.onDone).toHaveBeenCalledOnce())
    expect(h.claims().running.size).toBe(0)
    expect(h.claim.calls).toBe(1)
  })

  it("offers nothing off this tab's earlier read alone, nor once the reads missed the note", async () => {
    readEarlier()
    const h = await sheet()
    expect(h.flow.state.get().seedOnly).toBe(true)
    expect(h.flow.claim(false, Promise.resolve())).toBe(false)
    h.reads.answer(fresh())
    h.reads.settle(false)
    expect(h.flow.claim(false, Promise.resolve())).toBe(false)
    h.flow.retryRead()
    expect(h.reads.watches).toBe(2)
    h.reads.answer(fresh())
    expect(h.flow.claim(false, Promise.resolve())).toBe(true)
  })

  it("settles a read that never answers as missed, but not while a claim of the link runs", async () => {
    vi.useFakeTimers()
    const h = await sheet()
    openTestSession().claims.start(PAYLINK_FRAGMENT)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.flow.state.get().readSettled).toBe(false)
    openTestSession().claims.end(PAYLINK_FRAGMENT)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.flow.state.get()).toMatchObject({ readSettled: true, noteMissed: true })
  })

  it("records why a claim failed and reopens the prompt behind the error sheet", async () => {
    const shown: string[] = []
    const off = subscribeErrorModal((p) => void shown.push(p.message))
    const h = await sheet()
    h.reads.answer(fresh())
    h.flow.claim(false, Promise.resolve())
    h.claim.end(new Error("refused"))
    await vi.waitFor(() => expect(h.flow.state.get().claiming).toBe(false))
    expect(h.claims().reasons.has(PAYLINK_FRAGMENT)).toBe(true)
    expect(shown).toHaveLength(1)
    expect(h.inputs.onDone).not.toHaveBeenCalled()
    off()
  })

  it("stops Home's own claim again when the user closes a tapped claim's prompt", async () => {
    const h = await sheet({ requested: true })
    openTestSession().claims.decline(PAYLINK_FRAGMENT)
    h.reads.answer(fresh())
    h.flow.claim(false, Promise.resolve())
    expect(h.claims().declined.has(PAYLINK_FRAGMENT)).toBe(false)
    h.claim.end(Object.assign(new Error("closed"), { name: "NotAllowedError" }))
    await vi.waitFor(() => expect(h.flow.state.get().claiming).toBe(false))
    expect(h.claims().declined.has(PAYLINK_FRAGMENT)).toBe(true)
    expect(h.claims().reasons.size).toBe(0)
  })

  it("hands a claim the node already has off with no failure", async () => {
    const h = await sheet()
    h.reads.answer(fresh())
    h.flow.claim(false, Promise.resolve())
    h.claim.end(new TxInFlightError("0xclaim", new Error("lost")))
    await vi.waitFor(() => expect(h.inputs.onDone).toHaveBeenCalledOnce())
    expect(h.claims().reasons.size).toBe(0)
  })

  it("reports a failure after the hand-off only on the review", async () => {
    const h = await sheet()
    h.reads.answer(fresh())
    h.flow.claim(false, Promise.resolve())
    h.flow.handOff()
    h.claim.end(new Error("refused"))
    await vi.waitFor(() => expect(h.claims().reasons.has(PAYLINK_FRAGMENT)).toBe(true))
    expect(h.flow.state.get().claiming).toBe(true)
  })

  it("starts no second claim of a link at work", async () => {
    const h = await sheet()
    h.reads.answer(fresh())
    h.flow.claim(false, Promise.resolve())
    expect(h.flow.claim(false, Promise.resolve())).toBe(false)
  })

  it("shows nothing for a link already claiming, unless its review was asked for", async () => {
    openTestSession().claims.start(PAYLINK_FRAGMENT)
    expect((await sheet()).inputs.onDone).toHaveBeenCalledOnce()
    expect((await sheet({ requested: true })).inputs.onDone).not.toHaveBeenCalled()
  })

  it("clears a fragment that does not decode and closes", async () => {
    const onDone = vi.fn()
    stashClaimLink(tabStash, "not-a-link")
    openClaimFlow(openTestSession(), "not-a-link", () => ({
      requested: false,
      onDone,
      claimDeps: undefined,
      chainNow: 0,
      funding: null,
      detecting: false,
    })).start(new AbortController().signal)
    expect(onDone).toHaveBeenCalledOnce()
    expect(peekClaimStash(tabStash)).toBeNull()
  })

  it("publishes what the sheet decided of the link's funding as it reacts and as it ends", async () => {
    const checking = { fragment: PAYLINK_FRAGMENT, state: "checking" } as const
    const h = await sheet({ funding: checking })
    expect(h.claims().funding).toEqual(checking)
    h.inputs.funding = { fragment: PAYLINK_FRAGMENT, state: "review", amount: 5n }
    h.end()
    expect(h.claims().funding).toEqual(h.inputs.funding)
  })

  it("gives up deciding whether the link funds a registration only while it still decides", async () => {
    vi.useFakeTimers()
    const deciding = await sheet({ detecting: true })
    const decided = await sheet({ detecting: false })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deciding.flow.state.get().detectExpired).toBe(true)
    expect(decided.flow.state.get().detectExpired).toBe(false)
  })
})

describe("the claim sheet of a ticket signup's link", () => {
  it("re-reads the signup at the tap: terms that lapsed claim nothing", async () => {
    const h = await sheet({}, ticket())
    h.reads.answer(fresh())
    expect(h.flow.claim(true, Promise.resolve())).toBe(true)
    openTestSession().claims.end(PAYLINK_FRAGMENT)
    await seedRegistration(pendingRecord({ terms: ticket({ deadline: 1 }) }))
    expect(h.flow.claim(true, Promise.resolve())).toBe(false)
  })

  it("hands back the deposit the link was to pay once a fresh read finds it closed, once", async () => {
    readEarlier()
    const h = await sheet({}, ticket({ paylinkDeposit: true }))
    expect(h.released).toEqual([])
    h.reads.answer(fresh({ status: "claimed" }))
    h.reads.answer(fresh({ status: "claimed" }))
    expect(h.released).toEqual([SIPA])
  })

  it("hands back the deposit of a link read closed while a claim ran, once that claim fails", async () => {
    readEarlier()
    const h = await sheet({}, ticket({ paylinkDeposit: true }))
    h.reads.answer(fresh())
    expect(h.flow.claim(false, Promise.resolve(), false)).toBe(true)
    h.reads.answer(fresh({ status: "claimed" }))
    expect(h.released).toEqual([])
    h.claim.end(new Error("refused"))
    await vi.waitFor(() => expect(h.released).toEqual([SIPA]))
  })

  it("hands back the deposit of a link whose window closes on a chain tick", async () => {
    readEarlier()
    const h = await sheet({}, ticket({ paylinkDeposit: true }))
    h.reads.answer(fresh({ claimableUntil: 2_000 }))
    await vi.waitFor(() => expect(h.reads.tick).not.toBe(noTick))
    h.reads.tick(1_500)
    expect(h.released).toEqual([])
    h.reads.tick(2_500)
    expect(h.released).toEqual([SIPA])
  })

  it("keeps a registration whose burn is on its way", async () => {
    readEarlier()
    const h = await sheet({}, ticket({ paylinkDeposit: true }))
    await burn("submitting")
    h.reads.answer(fresh({ status: "claimed" }))
    expect(h.released).toEqual([])
  })

  it("hands off as Home's own claim of the link starts, unless its review was asked for", async () => {
    const shown = await sheet({ requested: true }, ticket())
    const own = await sheet({}, ticket())
    openTestSession().claims.start(PAYLINK_FRAGMENT)
    expect(own.inputs.onDone).toHaveBeenCalledOnce()
    expect(shown.inputs.onDone).not.toHaveBeenCalled()
  })

  it("keeps the review of a tapped retry after Home's own claim ended", async () => {
    openTestSession().claims.start(PAYLINK_FRAGMENT)
    openTestSession().claims.end(PAYLINK_FRAGMENT)
    const h = await sheet({}, ticket())
    h.reads.answer(fresh())
    expect(h.flow.claim(true, Promise.resolve())).toBe(true)
    expect(h.inputs.onDone).not.toHaveBeenCalled()
  })

  it("clears a link a completed signup spent, once its claim's burn went out", async () => {
    const h = await sheet({}, ticket())
    await seedRegistration(pendingRecord({ terms: ticket(), phase: "confirmed" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peekClaimStash(tabStash)).toBe(PAYLINK_FRAGMENT)
    await burn("done")
    await vi.waitFor(() => expect(peekClaimStash(tabStash)).toBeNull())
    expect(h.inputs.onDone).toHaveBeenCalled()
  })

  it("keeps a closed signup's link whose claim never burned", async () => {
    const h = await sheet({}, ticket())
    await burn("failed")
    await seedRegistration(pendingRecord({ terms: ticket(), phase: "failed_taken" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peekClaimStash(tabStash)).toBe(PAYLINK_FRAGMENT)
    expect(h.inputs.onDone).not.toHaveBeenCalled()
  })
})
