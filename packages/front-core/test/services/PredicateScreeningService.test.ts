import { createPace } from "@obsidion/core/cadence"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PredicateScreeningService,
  passThroughScreener,
  screenerOf,
  screenings,
  type PredicateScreeningConfig,
} from "../../src/core/services/screening/PredicateScreeningService"
import { queries } from "../../src/engine/query"
import { memoryStore } from "../../src/engine/store"

const CONFIG: PredicateScreeningConfig = {
  apiKey: "test-key",
  verificationHash: "x-managed-policy-abc",
  chain: "ethereum-sepolia",
}

const ADDRESS = "0xAaBbCcDdEeFf00112233445566778899aAbBcCdD"

function attestationResponse(
  body: {
    is_compliant: boolean
    reason?: { code: string; message: string }
  },
  init: { ok?: boolean; status?: number } = {},
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

const compliant = () => attestationResponse({ is_compliant: true })

const blocked = () =>
  attestationResponse({
    is_compliant: false,
    reason: { code: "sanctioned", message: "Address is sanctioned" },
  })

describe("PredicateScreeningService", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns compliant for a compliant address", async () => {
    fetchSpy.mockResolvedValue(compliant())
    const verdict = await new PredicateScreeningService(CONFIG).screen(ADDRESS)
    expect(verdict).toEqual({ compliant: true })
  })

  it("returns blocked with the policy's reason for a non-compliant address", async () => {
    fetchSpy.mockResolvedValue(blocked())
    const verdict = await new PredicateScreeningService(CONFIG).screen(ADDRESS)
    expect(verdict).toEqual({
      compliant: false,
      reason: { code: "sanctioned", message: "Address is sanctioned" },
    })
  })

  it("sends the api key, verification hash, address, and chain", async () => {
    fetchSpy.mockResolvedValue(compliant())
    await new PredicateScreeningService(CONFIG).screen(ADDRESS)

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://api.predicate.io/v2/attestation")
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("test-key")
    expect(JSON.parse(init!.body as string)).toEqual({
      verification_hash: "x-managed-policy-abc",
      from: ADDRESS,
      chain: "ethereum-sepolia",
    })
  })

  it("omits x-api-key when no key is configured — a key-injecting proxy owns it", async () => {
    fetchSpy.mockResolvedValue(compliant())
    const { apiKey: _key, ...keyless } = CONFIG
    await new PredicateScreeningService({ ...keyless, baseUrl: "/svc/predicate" }).screen(ADDRESS)

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("/svc/predicate/v2/attestation")
    expect(init!.headers as Record<string, string>).not.toHaveProperty("x-api-key")
  })

  it("targets the staging tier through baseUrl", async () => {
    fetchSpy.mockResolvedValue(compliant())
    await new PredicateScreeningService({
      ...CONFIG,
      baseUrl: "https://staging.api.predicate.io",
    }).screen(ADDRESS)
    expect(fetchSpy.mock.calls[0][0]).toBe("https://staging.api.predicate.io/v2/attestation")
  })

  it("throws on a non-ok response", async () => {
    fetchSpy.mockResolvedValue(
      attestationResponse({ is_compliant: true }, { ok: false, status: 500 }),
    )
    await expect(new PredicateScreeningService(CONFIG).screen(ADDRESS)).rejects.toThrow(/500/)
  })

  it("throws when the request fails", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"))
    await expect(new PredicateScreeningService(CONFIG).screen(ADDRESS)).rejects.toThrow(
      /network down/,
    )
  })

  it("passThroughScreener passes everything without touching the network", async () => {
    expect(await passThroughScreener.screen(ADDRESS)).toEqual({ compliant: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("screenings", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A page's verdicts over the Predicate client. */
  const screener = () => {
    const query = queries({
      pace: createPace({ signalled: false }),
      visible: memoryStore(true),
      now: () => Date.now(),
    })
    return screenerOf(screenings(query, new PredicateScreeningService(CONFIG)))
  }

  it("checks a compliant wallet once, keyed case-insensitively and across concurrent screens", async () => {
    fetchSpy.mockResolvedValue(compliant())
    const verdicts = screener()

    const [a, b] = await Promise.all([verdicts.screen(ADDRESS), verdicts.screen(ADDRESS)])
    expect([a, b]).toEqual([{ compliant: true }, { compliant: true }])
    await verdicts.screen(ADDRESS.toLowerCase())
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("re-queries a blocked wallet once its TTL passes", async () => {
    fetchSpy.mockResolvedValue(blocked())
    const verdicts = screener()

    await verdicts.screen(ADDRESS)
    vi.advanceTimersByTime(59_000)
    await verdicts.screen(ADDRESS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1_000)
    await verdicts.screen(ADDRESS)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("keeps no failure: the next screen asks again", async () => {
    fetchSpy.mockResolvedValue(
      attestationResponse({ is_compliant: true }, { ok: false, status: 500 }),
    )
    const verdicts = screener()

    await expect(verdicts.screen(ADDRESS)).rejects.toThrow(/500/)
    await expect(verdicts.screen(ADDRESS)).rejects.toThrow(/500/)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
