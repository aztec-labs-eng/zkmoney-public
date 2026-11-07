import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import {
  retryDelay,
  sipaDepositTransition,
  type SipaDepositEvent,
} from "../../src/engine/sipaDepositTransition"
import type { BroadcastState, SipaBroadcast, SipaDeposit } from "../../src/engine/sipaDeposits"

const NOW = 1_000_000
const SIPA = "0x00000000000000000000000000000000000000a1" as Address
const STATES: (BroadcastState | "none")[] = ["none", "queued", "proving", "sent", "landed"]

const job = (state: BroadcastState, over: Partial<SipaBroadcast> = {}): SipaBroadcast => ({
  kind: "deposit",
  source: { type: "slot" },
  state,
  createdAt: 1,
  failures: 0,
  ...(state === "sent" || state === "proving" ? { txHash: "0xhash" } : {}),
  ...over,
})

const record = (broadcast?: SipaBroadcast): SipaDeposit => ({
  sipaAddress: SIPA,
  version: 2,
  recipientL2Address: "0xrecipient",
  messageSecret: "0xsecret",
  recipientHash: "0xhash",
  recoveryAddress: "",
  l1ChainId: 1,
  networkId: "0xnet",
  amount: "0",
  tokenSymbol: "DAI",
  phase: "broadcast",
  startTime: 1,
  ...(broadcast ? { broadcast } : {}),
})

const owed: SipaDepositEvent = {
  type: "broadcastOwed",
  address: SIPA,
  owed: { kind: "deposit", source: { type: "slot" } },
  at: NOW,
}

/**
 * Every broadcast event, and the state it leaves a broadcast in from each state: a state,
 * `undefined` when the record is left as it is, or `null` when the broadcast leaves it.
 */
const TABLE: [string, SipaDepositEvent, (from: BroadcastState | "none") => unknown][] = [
  ["broadcastOwed", owed, (from) => (from === "none" ? "queued" : undefined)],
  ["broadcastRetry", { type: "broadcastRetry" }, () => undefined],
  [
    "broadcastProving",
    { type: "broadcastProving", operationId: "op" },
    (from) => (from === "none" || from === "landed" ? undefined : "proving"),
  ],
  [
    "broadcastHash",
    { type: "broadcastHash", txHash: "0xother" },
    (from) => (from === "none" || from === "landed" ? undefined : from),
  ],
  [
    "broadcastSent",
    { type: "broadcastSent", txHash: "0xhash" },
    (from) => (from === "proving" || from === "sent" ? "sent" : undefined),
  ],
  [
    "broadcastLanded",
    { type: "broadcastLanded" },
    (from) => (from === "none" || from === "landed" ? undefined : "landed"),
  ],
  [
    "broadcastFailed",
    { type: "broadcastFailed", failure: { code: "deposit.broadcastFailed" }, at: NOW },
    (from) => (from === "none" || from === "landed" ? undefined : "queued"),
  ],
  [
    "broadcastDeferred",
    { type: "broadcastDeferred", until: NOW + 5, wait: "unlock" },
    (from) => (from === "none" || from === "landed" ? undefined : "queued"),
  ],
  [
    "broadcastInterrupted",
    { type: "broadcastInterrupted" },
    (from) => (from === "proving" ? "sent" : undefined),
  ],
  [
    "broadcastAbandoned",
    { type: "broadcastAbandoned" },
    (from) => (from === "none" || from === "landed" ? undefined : null),
  ],
  [
    "broadcastRepublish",
    { type: "broadcastRepublish", sinceBlock: 9, at: NOW },
    (from) => (from === "landed" ? "queued" : undefined),
  ],
]

describe("sipaDepositTransition: broadcasts", () => {
  for (const [name, event, expected] of TABLE)
    for (const from of STATES)
      it(`${name} from ${from}`, () => {
        const before = record(from === "none" ? undefined : job(from))
        const next = sipaDepositTransition(before, event, NOW)
        const want = expected(from)
        if (want === undefined) return expect(next).toBeUndefined()
        expect(next).toBeTruthy()
        if (want === null) return expect(next!.broadcast).toBeUndefined()
        expect(next!.broadcast?.state).toBe(want)
      })

  it("owes a broadcast for an address with no record in a record that holds only it", () => {
    expect(sipaDepositTransition(undefined, owed, NOW)).toMatchObject({
      sipaAddress: SIPA,
      recipientL2Address: "",
      phase: "resolved",
      broadcast: { state: "queued", createdAt: NOW, failures: 0 },
    })
  })

  it("owes a broadcast whose hash is known as sent, and only moves an owed one's evidence", () => {
    const sent = sipaDepositTransition(
      undefined,
      { ...owed, owed: { ...(owed as { owed: SipaBroadcast }).owed, txHash: "0xmine" } },
      NOW,
    )
    expect(sent?.broadcast).toMatchObject({ state: "sent", txHash: "0xmine" })
    const pool = record(job("queued", { kind: "pool", failures: 3, retryAt: NOW + 9 }))
    const shown = sipaDepositTransition(
      pool,
      { ...owed, owed: { ...(owed as { owed: SipaBroadcast }).owed, shownAt: 5, fundedAt: 6 } },
      NOW,
    )
    expect(shown?.broadcast).toMatchObject({
      kind: "deposit",
      shownAt: 5,
      fundedAt: 6,
      failures: 0,
      retryAt: undefined,
    })
  })

  it("backs a failure off longer each time, and a retry clears it while queued", () => {
    const failed = sipaDepositTransition(
      record(job("proving", { failures: 1 })),
      { type: "broadcastFailed", failure: { code: "deposit.broadcastDropped" }, at: NOW },
      NOW,
    )
    expect(failed?.broadcast).toMatchObject({
      failures: 2,
      retryAt: NOW + retryDelay(2),
      txHash: undefined,
      failure: { code: "deposit.broadcastDropped" },
    })
    const retried = sipaDepositTransition(failed!, { type: "broadcastRetry" }, NOW)
    expect(retried?.broadcast).toMatchObject({ failures: 0, retryAt: undefined })
  })

  it("lands a republished broadcast only from its block on, with its funds first", () => {
    const next = sipaDepositTransition(
      record(job("landed", { txHash: "0xold", operationId: "op" })),
      { type: "broadcastRepublish", sinceBlock: 9, at: NOW },
      NOW,
    )
    expect(next?.broadcast).toMatchObject({
      state: "queued",
      republishSince: 9,
      fundedAt: NOW,
      txHash: undefined,
      operationId: undefined,
    })
  })

  it("makes a shown pool broadcast the user's, and funds move an owed slot to the front", () => {
    const pool = record(job("queued", { kind: "pool", failures: 2, retryAt: NOW + 9 }))
    expect(sipaDepositTransition(pool, { type: "shown", at: NOW }, NOW)).toMatchObject({
      startTime: NOW,
      broadcast: { kind: "deposit", shownAt: NOW, failures: 0, retryAt: undefined },
    })
    const funded = sipaDepositTransition(
      record(job("queued", { retryAt: NOW + 9 })),
      { type: "observed", fields: { amount: "1.5" } },
      NOW,
    )
    expect(funded?.broadcast).toMatchObject({ fundedAt: NOW, retryAt: undefined })
    const sent = sipaDepositTransition(
      record(job("queued")),
      { type: "fundingSent", fields: { fundingTxHash: "0xf" as Address } },
      NOW,
    )
    expect(sent?.broadcast?.fundedAt).toBe(NOW)
  })
})
