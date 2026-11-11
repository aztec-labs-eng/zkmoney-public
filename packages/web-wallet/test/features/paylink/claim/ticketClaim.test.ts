// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
/**
 * Home's own claim of a ticket signup's link as a session task: the gate it decides on, its
 * lifecycle, and how each end of a claim leaves the page's claims.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  memoryStore,
  startRuntime,
  TxInFlightError,
  WalletError,
  type ErrorCode,
  type OperationRecord,
  type RegistrationTerms,
  type Withdrawals,
} from "@obsidion/front-core"
import { decodePaylinkInline, nextOperationId } from "@obsidion/sdk"
import { runOperation } from "../../../../src/features/operations/operations"
import { createClaims } from "../../../../src/features/paylink/claims"
import { claimNote } from "../../../../src/features/paylink/sponsoredPaylink"
import { stashClaimLink } from "../../../../src/features/paylink/claimStash"
import { tabStash } from "../../../../src/platform/storage/tabStash"
import { linkIdentity } from "../../../../src/features/paylink/linkIdentity"
import {
  claimLinkId,
  claimRefused,
  TICKET_CLAIM_IO,
  ticketClaim,
  ticketClaimGate,
  ticketClaimView,
} from "../../../../src/features/paylink/ticketClaim"
import type { PaymentLink } from "../../../../src/features/paylink/types"
import { TimeoutError } from "../../../../src/lib/withTimeout"
import { closeSession } from "../../../../src/session/session"
import { openTestSession } from "../../../support/session"
import {
  L2_ADDRESS,
  SIPA,
  pendingRecord,
  seedRegistration,
} from "../../../support/registrationFixtures"
import { PAYLINK_FRAGMENT } from "../../../fixtures/scanPayloads"
import { later, sessions, table } from "../../../../../front-core/test/engine/taskTable"

const OPENS = 1_000
const link = (over: Partial<PaymentLink> = {}): PaymentLink => ({
  url: "u",
  fragment: PAYLINK_FRAGMENT,
  status: "unclaimed",
  flavor: "direct",
  claimableFrom: OPENS,
  ...over,
})
const OPEN_AT = OPENS + 30
describe("the automatic claim's gate", () => {
  const ready = { activation: "ready" as const, link: link(), chainNow: OPEN_AT, open: true }
  it.each([
    ["a signup not ready for its burn", { activation: "renew" as const }, { kind: "idle" }],
    ["no signup", { activation: undefined }, { kind: "idle" }],
    ["a link that does not decode", { link: null }, { kind: "idle" }],
    ["an email link", { link: link({ flavor: "email" }) }, { kind: "tap" }],
    ["a claimed link", { link: link({ status: "claimed" }) }, { kind: "tap" }],
    ["an expired window", { link: link({ claimableUntil: OPEN_AT - 1 }) }, { kind: "tap" }],
    [
      "an unread window: the claim itself decides",
      { link: link({ claimableFrom: undefined }) },
      {
        kind: "tap",
      },
    ],
    ["unread chain time", { chainNow: undefined }, { kind: "hold", hold: "preparing" }],
    [
      "a window still to open",
      { chainNow: OPEN_AT - 1 },
      { kind: "hold", hold: { claimableFrom: OPENS } },
    ],
    ["an upgrade or a move holding claims", { open: false }, { kind: "hold", hold: "preparing" }],
    ["an open window", {}, { kind: "claim" }],
  ])("%s", (_, over, gate) => {
    expect(ticketClaimGate({ ...ready, ...over })).toEqual(gate)
  })
})

describe("the automatic claim's view", () => {
  const hold = { kind: "hold", hold: "preparing" } as const
  const none = { running: new Set<string>(), declined: new Set<string>() }
  it.each([
    ["a claim of the link at work", hold, { ...none, running: new Set(["f"]) }, false, "claiming"],
    ["a claim of the link that failed for good", hold, none, true, "tap"],
    [
      "a claim of the link declined here",
      hold,
      { ...none, declined: new Set(["f"]) },
      false,
      "tap",
    ],
    ["a gate that asks for the tap", { kind: "tap" } as const, none, false, "tap"],
    ["a gate that holds", hold, none, false, "hold"],
    ["a gate that claims", { kind: "claim" } as const, none, false, "claiming"],
    ["no automatic claim", { kind: "idle" } as const, none, false, "idle"],
  ])("%s", (_, gate, claims, refused, kind) => {
    expect(ticketClaimView(gate, claims, "f", refused).kind).toBe(kind)
  })
})

describe("a link's refused claim", () => {
  const claim = (startedAt: number, over: Partial<OperationRecord>) =>
    ({
      operationId: `op-${startedAt}`,
      flow: "paylink-claim",
      summary: "Paylink",
      state: "failed",
      startedAt,
      kind: "paylink-claim",
      payload: { linkId: "L" },
      ...over,
    } as OperationRecord)
  it.each([
    ["a final failure", [claim(1, { failure: { code: "unknown" } })], true],
    ["a failure a retry may get past", [claim(1, { failure: { code: "timeout" } })], false],
    ["a sent claim the network turned down", [claim(1, { cause: "dropped" })], true],
    ["a failure the sweep wrote, with no code", [claim(1, { cause: "interrupted" })], false],
    [
      "a later try that runs",
      [claim(1, { failure: { code: "unknown" } }), claim(2, { state: "local" })],
      false,
    ],
    [
      "another link's failure",
      [claim(1, { failure: { code: "unknown" }, payload: { linkId: "M" } } as never)],
      false,
    ],
  ])("%s", (_, records, refused) => {
    expect(claimRefused(records, "L")).toBe(refused)
  })
})

const tab = new Map<string, string>()
vi.stubGlobal("location", { origin: "https://wallet.test" })
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => tab.get(key) ?? null,
  setItem: (key: string, value: string) => void tab.set(key, value),
  removeItem: (key: string) => void tab.delete(key),
})

/** This tab read the link before: the task claims off that read. */
const readEarlier = (over: Partial<PaymentLink> = {}) =>
  tab.set(`obsidion.link-read:${linkIdentity(PAYLINK_FRAGMENT)}`, JSON.stringify(link(over)))

const ticket: RegistrationTerms = {
  deadline: Math.floor(Date.now() / 1000) + 3_600,
  fee: "1",
  minDeposit: "0",
  paylinkFunded: true,
  paylinkId: linkIdentity(PAYLINK_FRAGMENT),
}

const ends: (() => void)[] = []
beforeEach(() => {
  tab.clear()
  for (const level of ["warn", "error", "info"] as const)
    vi.spyOn(console, level).mockImplementation(() => {})
  openTestSession()
})
afterEach(() => {
  for (const end of ends.splice(0)) end()
  closeSession()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A claim of the stashed link that failed with `code`, as its operation keeps it. */
async function failedClaim(code: ErrorCode) {
  const { operations } = openTestSession()
  const operationId = `claim-${code}`
  await operations.begin({ operationId, flow: "paylink-claim", summary: "Paylink" })
  const payload = { linkId: claimLinkId(PAYLINK_FRAGMENT)! } as never
  await operations.apply(operationId, {
    type: "transfer",
    transfer: { kind: "paylink-claim", payload },
  })
  await operations.apply(operationId, { type: "failed", failure: { code }, at: 1, quiet: true })
}

/** The task over the test session, a stashed link this tab read, and a signup ready for it. */
async function harness(
  io: Partial<typeof TICKET_CLAIM_IO> = {},
  read: Partial<PaymentLink> = {},
  withdrawals: Pick<Withdrawals, "ready" | "list"> = openTestSession().withdrawals,
) {
  stashClaimLink(tabStash, PAYLINK_FRAGMENT)
  readEarlier(read)
  await seedRegistration(pendingRecord({ terms: ticket }))
  const claims = createClaims()
  const calls = { claims: 0, shown: [] as string[] }
  let answer: () => Promise<string> = async () => "0xclaim"
  const session = openTestSession()
  const needs = {
    wallet: later<never>("wallet"),
    account: later<never>("account"),
    tokenService: later<never>("tokenService"),
    teeSigner: later<never>("teeSigner"),
    contractService: later<never>("contractService"),
  }
  const h = sessions(startRuntime)
  ends.push(h.end)
  h.tasks.push(
    ticketClaim(
      {
        wallet: needs.wallet.service,
        account: needs.account.service,
        tokenService: needs.tokenService.service,
        teeSigner: needs.teeSigner.service,
        contractService: needs.contractService.service,
      },
      // The session's own stores, with the test's claims and burns.
      Object.assign(Object.create(session), {
        claims,
        withdrawals: withdrawals as Withdrawals,
        backupRotations: null,
      }),
      {
        chainSeconds: async () => OPEN_AT,
        open: async () => true,
        claim: () => (calls.claims++, answer()),
        claimed: async () => false,
        showFailure: (_, reason) => void calls.shown.push(reason),
        ...io,
      },
    ),
  )
  const account = { getAddress: () => ({ toString: () => L2_ADDRESS }) }
  const ready = () => {
    needs.account.ready(account as never)
    for (const name of ["wallet", "tokenService", "teeSigner", "contractService"] as const)
      needs[name].ready({ node: {} } as never)
  }
  /** The claim fails with `e`, its operation failed as the claim's flow leaves it. */
  const fail = (e: unknown, code?: ErrorCode) =>
    (answer = async () => {
      if (code) await failedClaim(code)
      throw e
    })
  return { ...h, claims, calls, ready, fail, lose: () => needs.wallet.lose() }
}

it("passes every five seconds once its needs are ready, hidden too, and stops with the session", async () => {
  vi.useFakeTimers()
  let passes = 0
  const h = await harness({ chainSeconds: async () => (passes++, OPENS - 10) })
  await table(
    [
      ["start, a need pending", h.start, 5_000, 0],
      ["the need is ready", h.ready, 0, 1],
      ["visible", () => {}, 5_000, 2],
      ["hidden", h.hide, 10_000, 4],
      ["stop", h.stop, 20_000, 4],
      ["restart", h.start, 0, 5],
    ],
    () => passes,
  )
})

it("holds while the window is shut, then claims once it opens and the link stays running till it ends", async () => {
  vi.useFakeTimers()
  let chainNow = OPENS
  const h = await harness({ chainSeconds: async () => chainNow })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(0)
  chainNow = OPEN_AT
  await vi.advanceTimersByTimeAsync(5_000)
  const state = h.claims.state.get()
  expect(h.calls.claims).toBe(1)
  expect(state.running.has(PAYLINK_FRAGMENT)).toBe(false)
})

it("leaves a link another surface is claiming", async () => {
  vi.useFakeTimers()
  const h = await harness()
  h.claims.start(PAYLINK_FRAGMENT)
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.calls.claims).toBe(0)
})

it("starts no claim of a link another surface started while the pass waited", async () => {
  vi.useFakeTimers()
  const h = await harness({
    open: async () => {
      h.claims.start(PAYLINK_FRAGMENT)
      return true
    },
  })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(0)
})

it("starts no claim of a link whose tapped claim failed for good while the pass waited", async () => {
  vi.useFakeTimers()
  const h = await harness({
    open: async () => {
      await failedClaim("unknown")
      return true
    },
  })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(0)
})

it("stops on a final failure of the link's claim across a reload, and not on a retryable one", async () => {
  vi.useFakeTimers()
  await failedClaim("timeout")
  const retried = await harness()
  retried.start()
  retried.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(retried.calls.claims).toBe(1)
  retried.end()

  await failedClaim("registration.ticketRefused")
  const reloaded = await harness()
  reloaded.start()
  reloaded.ready()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reloaded.calls.claims).toBe(0)
})

it("stops after one try on a link that does not match its escrow, and stays stopped on reload", async () => {
  vi.useFakeTimers()
  const deps = {
    wallet: { networkId: "0xroll" },
    tokenService: {
      fetchTokenInformation: async () => ({
        symbol: "DAI",
        name: "DAI",
        address: "0xt",
        decimals: 18,
      }),
    },
  } as never
  const refused = () =>
    runOperation(
      openTestSession(),
      { operationId: nextOperationId("paylink-claim"), flow: "paylink-claim", summary: "" },
      async (op) => {
        await claimNote(
          op,
          deps,
          decodePaylinkInline(PAYLINK_FRAGMENT),
          Promise.reject(new WalletError("paylink.termsMismatch")),
        )
        return "0xclaim"
      },
    )
  const h = await harness({ claim: refused })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.claims.state.get().reasons.has(PAYLINK_FRAGMENT)).toBe(true)
  h.end()
  const reloaded = await harness({ claim: refused })
  reloaded.start()
  reloaded.ready()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(openTestSession().operations.view.get().records).toHaveLength(1)
})

it("waits for a transaction the user runs, then claims on a later pass", async () => {
  vi.useFakeTimers()
  let finish: () => void = () => {}
  const send = openTestSession().page.prover.runUserFlow(
    () => new Promise<void>((resolve) => (finish = resolve)),
  )
  const h = await harness()
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.calls.claims).toBe(0)
  finish()
  await send
  await vi.advanceTimersByTimeAsync(5_000)
  expect(h.calls.claims).toBe(1)
})

it("reads a link claimed elsewhere before any proof, and asks Home for its review", async () => {
  vi.useFakeTimers()
  const h = await harness({ claimed: async () => true })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(0)
  expect(h.claims.state.get().requested).toBe(PAYLINK_FRAGMENT)
  h.claims.request(null)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.claims.state.get().requested).toBeNull()
})

it("starts no claim of a link another surface sent while the pass waited", async () => {
  vi.useFakeTimers()
  const h = await harness({
    open: async () => {
      await openTestSession().withdrawals.create({
        networkId: "0xnet",
        localId: "w1",
        recipient: SIPA,
        recipientProvenance: "saved-recipient",
        amount: "5",
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        phase: "submitting",
        startTime: 1,
      })
      return true
    },
  })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(0)
})

it("lets go of a claim verdict that never answers once its run is let go", async () => {
  vi.useFakeTimers()
  let verdicts = 0
  const h = await harness({
    open: () => (verdicts++ === 0 ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
  })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  h.lose()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(1)
})

it("claims nothing before the burns load", async () => {
  vi.useFakeTimers()
  const list = memoryStore({ hydrated: false, records: [] })
  const h = await harness({}, {}, { ready: Promise.resolve(), list } as never)
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.calls.claims).toBe(0)
})

it("starts no claim once its run is let go while it waited", async () => {
  vi.useFakeTimers()
  const h = await harness({
    open: async () => {
      h.lose()
      return true
    },
  })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(0)
})

it("hands a link whose window closed to the review's tap", async () => {
  vi.useFakeTimers()
  const h = await harness({}, { claimableUntil: OPEN_AT - 1 })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(0)
})

it("backs off after a failure a later try may get past, kept across a restart, and tries again", async () => {
  vi.useFakeTimers()
  const h = await harness()
  h.fail(new Error("voucher read", { cause: new TimeoutError(1) }))
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.calls.claims).toBe(1)
  const state = h.claims.state.get()
  expect(state.reasons.has(PAYLINK_FRAGMENT) || state.requested !== null).toBe(false)
  h.stop()
  h.start()
  await vi.advanceTimersByTimeAsync(4_000)
  expect(h.calls.claims).toBe(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(h.calls.claims).toBe(2)
})

describe("an automatic claim that ends without a claim", () => {
  it.each([
    ["a failure", new WalletError("registration.ticketRefused"), 1],
    ["a cancelled passkey", Object.assign(new Error("closed"), { name: "NotAllowedError" }), 0],
  ])("on %s, asks Home for the review and runs no more", async (_, error, shown) => {
    vi.useFakeTimers()
    const h = await harness()
    h.fail(error, error instanceof WalletError ? error.code : undefined)
    h.start()
    h.ready()
    await vi.advanceTimersByTimeAsync(0)
    const state = h.claims.state.get()
    expect(state.requested).toBe(PAYLINK_FRAGMENT)
    expect(state.reasons.has(PAYLINK_FRAGMENT)).toBe(shown > 0)
    expect(state.declined.has(PAYLINK_FRAGMENT)).toBe(shown === 0)
    expect(h.calls.shown.length).toBe(shown)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls.claims).toBe(1)
  })

  it("is none for a claim the node already has: the bell follows it", async () => {
    vi.useFakeTimers()
    const h = await harness()
    h.fail(new TxInFlightError("0xclaim", new Error("lost")))
    h.start()
    h.ready()
    await vi.advanceTimersByTimeAsync(0)
    const state = h.claims.state.get()
    expect(state.reasons.has(PAYLINK_FRAGMENT) || state.requested !== null).toBe(false)
    expect(state.running.has(PAYLINK_FRAGMENT)).toBe(false)
  })
})

it("keeps a claim running when its run is let go, so no second claim starts", async () => {
  vi.useFakeTimers()
  let end: (hash: string) => void = () => {}
  let claims = 0
  const h = await harness({ claim: () => (claims++, new Promise((resolve) => (end = resolve))) })
  h.start()
  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  h.lose()
  h.ready()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.claims.state.get().running.has(PAYLINK_FRAGMENT)).toBe(true)
  expect(claims).toBe(1)
  end("0xclaim")
  await vi.advanceTimersByTimeAsync(0)
  expect(h.claims.state.get().running.has(PAYLINK_FRAGMENT)).toBe(false)
})
