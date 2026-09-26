import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PredicateScreeningService,
  passThroughScreener,
  type PredicateScreeningConfig,
} from "../../src/core/services/screening/PredicateScreeningService"

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

  it("checks a compliant wallet once, keyed case-insensitively", async () => {
    fetchSpy.mockResolvedValue(compliant())
    const service = new PredicateScreeningService(CONFIG)

    await service.screen(ADDRESS)
    await service.screen(ADDRESS.toLowerCase())
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("shares one request across concurrent screens of the same wallet", async () => {
    fetchSpy.mockResolvedValue(compliant())
    const service = new PredicateScreeningService(CONFIG)

    const [a, b] = await Promise.all([service.screen(ADDRESS), service.screen(ADDRESS)])
    expect(a).toEqual({ compliant: true })
    expect(b).toEqual({ compliant: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("re-queries a blocked wallet once its TTL passes", async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(blocked())
    const service = new PredicateScreeningService(CONFIG)

    await service.screen(ADDRESS)
    await service.screen(ADDRESS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(61_000)
    await service.screen(ADDRESS)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it("throws and does not cache on a non-ok response", async () => {
    fetchSpy.mockResolvedValue(
      attestationResponse({ is_compliant: true }, { ok: false, status: 500 }),
    )
    const service = new PredicateScreeningService(CONFIG)

    await expect(service.screen(ADDRESS)).rejects.toThrow(/500/)
    await expect(service.screen(ADDRESS)).rejects.toThrow(/500/)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
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
