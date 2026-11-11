// @vitest-environment node
/** The golden ticket offer read from `/domain/info`, and what a view shows of it. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DomainInfoResponse } from "@obsidion/front-core"
import {
  offerFailed,
  pageTicketOffer,
  shownOffer,
} from "../../../../src/features/paylink/ticketOffer"
import { sandboxConfig } from "../../../support/seedBootConfig"
import { testQuery } from "../../../support/query"

const schedule = { fee: "500000", minDeposit: "0" }
const OFFER = { threshold: "2000000", schedule }

const answer = (goldenTicket: DomainInfoResponse["goldenTicket"]) =>
  new Response(JSON.stringify({ goldenTicket }), {
    headers: { "Content-Type": "application/json" },
  })

let fetch: ReturnType<typeof vi.fn>
let config: Awaited<ReturnType<typeof sandboxConfig>>
const offer = () => pageTicketOffer(testQuery(), config)
/** Opens a view of `entry` until the returned close. */
const open = (entry: ReturnType<typeof offer>) => entry.subscribe(() => {})
const shown = (entry: ReturnType<typeof offer>) => shownOffer(entry.get())

beforeEach(async () => {
  config = await sandboxConfig()
  fetch = vi.fn(async (url: string) => {
    expect(new URL(url).pathname).toBe("/domain/info")
    return answer(OFFER)
  })
  vi.stubGlobal("fetch", fetch)
})
afterEach(() => vi.unstubAllGlobals())

describe("the page's ticket offer", () => {
  it("returns the threshold and the schedule it buys", async () => {
    await expect(offer().read()).resolves.toEqual(OFFER)
  })

  it("offers nothing where tickets are off or the server sends no schedule", async () => {
    fetch.mockResolvedValueOnce(answer(null))
    await expect(offer().read()).resolves.toBeNull()
    fetch.mockResolvedValueOnce(answer({ threshold: "2000000" }))
    await expect(offer().read()).resolves.toBeNull()
  })

  it.each(["2.5", "", "0x3"])("fails on a threshold that is not base units (%j)", async (t) => {
    fetch.mockResolvedValueOnce(answer({ threshold: t, schedule }))
    await expect(offer().read()).rejects.toThrow()
  })

  it("keeps a failed read apart from an absent offer, and reads again on refresh", async () => {
    fetch.mockResolvedValueOnce(new Response("down", { status: 503 }))
    const entry = offer()
    const close = open(entry)
    await vi.waitFor(() => expect(entry.get().status).toBe("failed"))
    expect(shown(entry)).toBeUndefined()
    entry.refresh()
    await vi.waitFor(() => expect(shown(entry)).toEqual(OFFER))
    expect(fetch).toHaveBeenCalledTimes(2)
    close()
  })

  it("reads once for views that overlap, and again for one opened after the last closed", async () => {
    const entry = offer()
    const early = open(entry)
    await vi.waitFor(() => expect(shown(entry)).toEqual(OFFER))
    const first = open(entry)
    early()
    expect(shown(entry)).toEqual(OFFER)
    expect(fetch).toHaveBeenCalledOnce()
    first()
    // With no view open, the earlier read is already not shown: the next view reads it again.
    expect(shown(entry)).toBeUndefined()

    fetch.mockResolvedValueOnce(answer({ ...OFFER, threshold: "4" }))
    const later = open(entry)
    // The earlier read is not shown while the offer is read again.
    expect(shown(entry)).toBeUndefined()
    await vi.waitFor(() => expect(shown(entry)).toEqual({ ...OFFER, threshold: "4" }))
    later()
  })
})

describe("what a view shows of the offer's read", () => {
  it("shows a view opened later no offer, and the failure, when its read again fails", async () => {
    const entry = offer()
    const early = open(entry)
    await vi.waitFor(() => expect(shown(entry)).toEqual(OFFER))
    early()
    fetch.mockResolvedValueOnce(new Response("down", { status: 503 }))
    const later = open(entry)
    await vi.waitFor(() => expect(offerFailed(entry.get())).toBe(true))
    expect(shown(entry)).toBeUndefined()
    later()
  })

  const down = new Error("down")
  it.each([
    ["a fresh read", { status: "ready", value: OFFER, refreshing: false }, OFFER, false],
    [
      "a read again in flight",
      { status: "ready", value: OFFER, refreshing: true },
      undefined,
      false,
    ],
    [
      "a failed read again",
      { status: "ready", value: OFFER, refreshing: false, error: down },
      undefined,
      true,
    ],
    ["a failed first read", { status: "failed", error: down }, undefined, true],
  ] as const)("shows %s as offer %o, failed %s", (_, state, offer, failed) => {
    expect(shownOffer(state)).toEqual(offer)
    expect(offerFailed(state)).toBe(failed)
  })
})
