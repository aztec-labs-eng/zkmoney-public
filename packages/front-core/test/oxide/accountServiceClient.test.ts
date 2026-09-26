import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"

import { sha256 } from "@aztec/foundation/crypto/sha256"

import {
  AccountServiceClient,
  AccountServiceError,
  AccountServiceTimeoutError,
  ATTEST_KEY_PREIMAGE,
  BOOTSTRAP_SIGNATURE_HEADER,
  BUNDLER_BUNDLE_PREIMAGE,
  claimRefusalReason,
  DOMAIN_RESERVATION_PREIMAGE,
  DOMAIN_SIGN_PREIMAGE,
  ReadOnlyClientError,
  isClaimConflict,
  PAYMASTER_SPONSOR_PREIMAGE,
  withClaimRetry,
  sponsorRequestFingerprint,
  type SponsorResponse,
  type UserOpJson,
} from "../../src/oxide/accountServiceClient"

// Stands in for the platform attestation; returns a fixed
// assertion so the gated-route header can be asserted.
const assertionProvider = { generateAssertion: vi.fn(async () => "test-assertion") }

// ── Fixed parity vector (shared byte-for-byte with the backend parity test) ──
const FIXED_OP: UserOpJson = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "7",
  initCode: "0x",
  callData: "0xdeadbeef",
  accountGasLimits: `0x${"01".repeat(32)}`,
  preVerificationGas: "21000",
  gasFees: `0x${"02".repeat(32)}`,
  paymasterAndData: "0x",
  signature: "0x",
}

// Pinned in BOTH this test and the account-service backend parity test; drift on
// either side fails CI rather than on-device at /paymaster/sponsor.
const EXPECTED_SPONSOR_FINGERPRINT: Hex =
  "0x0f63d8034a723ba3b141ed26eda7ab966e268c9ee54150f8f0a03a1a03606fc9"

const SPONSORED: SponsorResponse = {
  accountGasLimits: `0x${"03".repeat(32)}`,
  preVerificationGas: "50000",
  gasFees: `0x${"04".repeat(32)}`,
  paymasterAndData: "0xbeef",
  validUntil: "0",
  validAfter: "0",
}

describe("account-service preimages", () => {
  it("builds the service-namespaced preimages, lowercasing hex", () => {
    expect(ATTEST_KEY_PREIMAGE("KeyId123")).toBe("OBSIDION_ACCT_AUTH_V1:ATTEST:KeyId123")
    expect(DOMAIN_SIGN_PREIMAGE("0xAB", "0xCd")).toBe("OBSIDION_ACCT_AUTH_V1:DOMAIN_SIGN:0xab:0xcd")
    expect(PAYMASTER_SPONSOR_PREIMAGE("0xFF")).toBe("OBSIDION_ACCT_AUTH_V1:SPONSOR:0xff")
    expect(BUNDLER_BUNDLE_PREIMAGE("0xFF")).toBe("OBSIDION_ACCT_AUTH_V1:BUNDLE:0xff")
  })
})

describe("account-service preimage parity (pinned)", () => {
  // Pinned in BOTH this test and the account-service route test.
  it("the reservation lookup preimage matches the pinned vector", () => {
    expect(
      DOMAIN_RESERVATION_PREIMAGE("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", 1_789_500_000),
    ).toBe(
      "OBSIDION_ACCT_AUTH_V1:DOMAIN_RESERVATION:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf:1789500000",
    )
  })

  it("sponsorRequestFingerprint matches the pinned vector", () => {
    expect(sponsorRequestFingerprint(FIXED_OP)).toBe(EXPECTED_SPONSOR_FINGERPRINT)
  })

  it("the sponsor fingerprint ignores paymasterAndData + signature", () => {
    const withStuff: UserOpJson = { ...FIXED_OP, paymasterAndData: "0xabcd", signature: "0xdead" }
    expect(sponsorRequestFingerprint(withStuff)).toBe(sponsorRequestFingerprint(FIXED_OP))
  })
})

describe("claim refusal classifiers", () => {
  const refusal = (status: number, reason: string) =>
    new AccountServiceError(status, "refused", { error: "refused", reason })

  it("names the one 409 no in-window retry can clear", () => {
    expect(claimRefusalReason(refusal(409, "claim_conflict"))).toBe("claim_conflict")
    expect(isClaimConflict(refusal(409, "claim_conflict"))).toBe(true)
    expect(isClaimConflict(refusal(409, "claim_inflight"))).toBe(false)
    expect(isClaimConflict(refusal(409, "claim_superseded"))).toBe(false)
    expect(isClaimConflict(refusal(409, "name_reserved"))).toBe(false)
    expect(isClaimConflict(refusal(503, "claim_conflict"))).toBe(false)
    expect(isClaimConflict(new Error("claim_conflict"))).toBe(false)
  })
})

describe("withClaimRetry", () => {
  const refusal = (status: number, reason: string, retryAfterSec?: number) =>
    new AccountServiceError(status, "refused", { error: "refused", reason }, retryAfterSec)

  // A virtual clock: the budget is spent by the naps the retry itself asks for, so a test never
  // waits and the attempt count is exactly what the budget pays for.
  const virtualClock = () => {
    let ms = 0
    return {
      now: () => ms,
      sleep: async (by: number) => {
        ms += by
      },
    }
  }

  it("waits out a claim_conflict and returns the claim the retry wins", async () => {
    const clock = virtualClock()
    const onWait = vi.fn()
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(refusal(409, "claim_conflict"))
      .mockRejectedValueOnce(refusal(409, "claim_conflict"))
      .mockResolvedValueOnce("claim")

    expect(await withClaimRetry(attempt, { ...clock, onWait })).toBe("claim")
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(onWait.mock.calls).toEqual([["claim_conflict"]])
  })

  it("waits out the other two self-clearing refusals", async () => {
    for (const reason of ["claim_inflight", "claim_superseded"]) {
      const attempt = vi
        .fn()
        .mockRejectedValueOnce(refusal(409, reason))
        .mockResolvedValueOnce("ok")
      expect(await withClaimRetry(attempt, virtualClock())).toBe("ok")
      expect(attempt).toHaveBeenCalledTimes(2)
    }
  })

  it("fails fast on every terminal refusal, spending no wait on it", async () => {
    const terminal = [
      refusal(409, "name_reserved"),
      refusal(403, "name_blocked"),
      refusal(429, "claim_attempts_exhausted", 600),
      new Error("network down"),
    ]
    for (const err of terminal) {
      const onWait = vi.fn()
      const attempt = vi.fn().mockRejectedValue(err)
      await expect(withClaimRetry(attempt, { ...virtualClock(), onWait })).rejects.toBe(err)
      expect(attempt).toHaveBeenCalledTimes(1)
      expect(onWait).not.toHaveBeenCalled()
    }
  })

  it("surfaces the refusal that outlasted the budget, so the caller can name the hold", async () => {
    const err = refusal(409, "claim_conflict")
    const attempt = vi.fn().mockRejectedValue(err)

    await expect(withClaimRetry(attempt, virtualClock())).rejects.toBe(err)
    // Backoff doubles from 400ms to a 6s cap, so the default budget buys a bounded handful.
    expect(attempt.mock.calls.length).toBeGreaterThan(4)
    expect(attempt.mock.calls.length).toBeLessThan(15)
  })

  it("never starts a wait it cannot finish inside the budget", async () => {
    const attempt = vi.fn().mockRejectedValue(refusal(409, "claim_inflight", 600))
    const onWait = vi.fn()

    await expect(withClaimRetry(attempt, { ...virtualClock(), onWait })).rejects.toMatchObject({
      status: 409,
    })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onWait).not.toHaveBeenCalled()
  })
})

describe("AccountServiceClient HTTP", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  it("reads availability from the open route, with no credential", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "reserved" }))
    const client = new AccountServiceClient("https://acct.test", { readOnly: true })

    expect(await client.availableName(`0x${"ab".repeat(32)}`)).toBe("reserved")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://acct.test/domain/available?nameHash=0x${"ab".repeat(32)}`)
    expect(init.method).toBe("GET")
    expect(init.headers).toBeUndefined()
  })

  it("keeps the blocklist flag when a name is also reserved", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "reserved", blocked: true }))
    const client = new AccountServiceClient("https://acct.test", { readOnly: true })

    expect(await client.availableNameDetails(`0x${"ab".repeat(32)}`)).toEqual({
      status: "reserved",
      blocked: true,
    })
  })

  it("retries a read whose fetch rejected, since nothing was processed", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(json({ status: "available" }))
    const client = new AccountServiceClient("https://acct.test", { readOnly: true })

    expect(await client.availableName(`0x${"cd".repeat(32)}`)).toBe("available")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("never retries a 429 — the budget is spent by retrying, not by waiting", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "600" },
      }),
    )
    const client = new AccountServiceClient("https://acct.test", { readOnly: true })

    await expect(client.availableName(`0x${"ef".repeat(32)}`)).rejects.toMatchObject({
      status: 429,
      retryAfterSec: 600,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("never replays /domain/sign, which the service counts even when the reply is lost", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"))
    const client = new AccountServiceClient("https://acct.test", { testMode: true })

    await expect(
      client.signDomain({
        keyId: "k",
        nameHash: `0x${"11".repeat(32)}`,
        userAddress: "0x2222222222222222222222222222222222222222",
      }),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("gates /paymaster/sponsor with the assertion header and returns the sponsored fields", async () => {
    fetchMock.mockResolvedValueOnce(json(SPONSORED))

    const client = new AccountServiceClient("https://as.example.com/", { assertionProvider })
    const out = await client.sponsor({ keyId: "k1", userOp: FIXED_OP })

    expect(out).toEqual(SPONSORED)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://as.example.com/paymaster/sponsor")
    expect(init.method).toBe("POST")
    expect(init.headers["x-app-attest-assertion"]).toBe("test-assertion")
    expect(JSON.parse(init.body)).toEqual({ keyId: "k1", userOp: FIXED_OP })
  })

  it("gates /bundler/bundle on the locally-derived userOpHash and returns the userOpHash", async () => {
    fetchMock.mockResolvedValueOnce(json({ userOpHash: `0x${"ab".repeat(32)}` }))

    const client = new AccountServiceClient("https://as.example.com", { assertionProvider })
    const out = await client.bundle({
      keyId: "k1",
      userOp: FIXED_OP,
      userOpHash: `0x${"ab".repeat(32)}`,
    })

    expect(out.userOpHash).toBe(`0x${"ab".repeat(32)}`)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://as.example.com/bundler/bundle")
    expect(init.headers["x-app-attest-assertion"]).toBe("test-assertion")
    // The hash is bound via the assertion preimage, never sent in the body.
    expect(JSON.parse(init.body)).toEqual({ keyId: "k1", userOp: FIXED_OP })
  })

  it("polls /bundler/receipt WITHOUT an assertion header (open read)", async () => {
    fetchMock.mockResolvedValueOnce(json({ receipt: null }))
    const client = new AccountServiceClient("https://as.example.com", { assertionProvider })
    const out = await client.receipt({ userOpHash: `0x${"ab".repeat(32)}` })
    expect(out.receipt).toBeNull()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://as.example.com/bundler/receipt")
    expect(init.headers["x-app-attest-assertion"]).toBeUndefined()
  })

  it("skips assertion generation in account-service test mode", async () => {
    fetchMock.mockResolvedValueOnce(json(SPONSORED))

    const client = new AccountServiceClient("https://as.example.com", { testMode: true })
    await client.sponsor({ keyId: "k1", userOp: FIXED_OP })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers["x-app-attest-assertion"]).toBeUndefined()
  })

  it("relays /attest/key WITHOUT an assertion header", async () => {
    fetchMock.mockResolvedValueOnce(json({ keyId: "k1" }, 201))
    const client = new AccountServiceClient("https://as.example.com", { assertionProvider })
    await client.registerKey({ keyId: "k1", attestation: "att" })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers["x-app-attest-assertion"]).toBeUndefined()
    expect(JSON.parse(init.body)).toEqual({ keyId: "k1", attestation: "att" })
  })

  it("surfaces a 409 as a typed AccountServiceError carrying the status", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "name already registered" }, 409))
    const client = new AccountServiceClient("https://as.example.com", { assertionProvider })
    const err = await client.sponsor({ keyId: "k1", userOp: FIXED_OP }).catch((e) => e)
    expect(err).toBeInstanceOf(AccountServiceError)
    expect(err).toMatchObject({ status: 409, name: "AccountServiceError" })
  })

  it("binds a testMode golden ticket to the owner named before the proof", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "created" }))
    const client = new AccountServiceClient("https://acct.test", { testMode: true })
    const owner = "0x2222222222222222222222222222222222222222" as Hex
    const nullifier = `0x${"33".repeat(32)}` as Hex

    await expect(
      client.redeemGoldenTicket({
        proof: "0xaa",
        root: `0x${"11".repeat(32)}`,
        blockNumber: 4,
        nullifier,
        owner,
      }),
    ).resolves.toEqual({ status: "created" })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://acct.test/domain/golden-ticket")
    expect(JSON.parse(init.body)).toMatchObject({ keyId: owner, owner, nullifier })
  })

  it("names a testMode NameClaim with the bootstrap subject when one is wired", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ signature: "0xsig", nonce: "1", deadline: "9999999999" }),
    )
    const subject = "0x2222222222222222222222222222222222222222"
    const client = new AccountServiceClient("https://acct.test", {
      testMode: true,
      bootstrapProvider: {
        subject,
        signClientDataHash: async () => "0xsig" as Hex,
      },
    })

    await client.signDomain({
      nameHash: `0x${"11".repeat(32)}`,
      userAddress: "0x3333333333333333333333333333333333333333",
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).keyId).toBe(subject)
    expect(init.headers["x-obsidion-bootstrap-signature"]).toBeUndefined()
  })

  it("refuses to redeem a golden ticket with no bootstrap subject", async () => {
    const client = new AccountServiceClient("https://acct.test", { testMode: true })
    await expect(
      client.redeemGoldenTicket({
        proof: "0xaa",
        root: `0x${"11".repeat(32)}`,
        blockNumber: 4,
        nullifier: `0x${"33".repeat(32)}`,
      }),
    ).rejects.toThrow(/no bootstrap subject/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("AccountServiceClient.claimedNames", () => {
  const SUBJECT = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
  const H1 = `0x${"ab".repeat(32)}` as Hex
  const H2 = `0x${"cd".repeat(32)}` as Hex
  const fetchMock = vi.fn()
  const signClientDataHash = vi.fn(async (_hash: Uint8Array) => `0x${"ee".repeat(65)}` as Hex)
  const bootstrapProvider = { subject: SUBJECT, signClientDataHash }
  const client = (opts: { grantToken?: string } = {}) =>
    new AccountServiceClient("https://as.example.com", { bootstrapProvider, ...opts })

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
    signClientDataHash.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  /** Headers arrive at once; the body never finishes until the request is aborted. */
  const stalledBody = (status: number) => (_url: string, init: RequestInit) => {
    const body = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        )
      },
    })
    return Promise.resolve(new Response(body, { status }))
  }

  it("signs the timestamped preimage with the bootstrap key and returns the hashes", async () => {
    vi.useFakeTimers({ now: 1_789_500_000_000, toFake: ["Date"] })
    fetchMock.mockResolvedValueOnce(json({ nameHashes: [H1, H2] }))

    expect(await client({ grantToken: "tok" }).claimedNames({ timeoutMs: 15_000 })).toEqual([
      H1,
      H2,
    ])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://as.example.com/domain/reservation")
    expect(init.method).toBe("POST")
    expect(init.headers[BOOTSTRAP_SIGNATURE_HEADER]).toBe(`0x${"ee".repeat(65)}`)
    // The grant token is only ever spent at /domain/sign.
    expect(JSON.parse(init.body)).toEqual({ keyId: SUBJECT, timestamp: 1_789_500_000 })
    expect(signClientDataHash).toHaveBeenCalledWith(
      sha256(Buffer.from(DOMAIN_RESERVATION_PREIMAGE(SUBJECT, 1_789_500_000), "utf-8")),
    )
  })

  it("returns an empty list as an answer", async () => {
    fetchMock.mockResolvedValueOnce(json({ nameHashes: [] }))
    expect(await client().claimedNames({ timeoutMs: 15_000 })).toEqual([])
  })

  it.each([401, 404, 429, 503])("throws AccountServiceError on %i", async (status) => {
    fetchMock.mockResolvedValueOnce(json({ error: "no" }, status))
    const err = await client()
      .claimedNames({ timeoutMs: 15_000 })
      .catch((e) => e)
    expect(err).toBeInstanceOf(AccountServiceError)
    expect(err.status).toBe(status)
  })

  it.each([
    ["an empty object", {}],
    ["a string", { nameHashes: `0x${"ab".repeat(32)}` }],
    ["a short hash", { nameHashes: [H1, "0xabcd"] }],
    ["a non-hex hash", { nameHashes: [`0x${"zz".repeat(32)}`] }],
    ["null", null],
  ])("throws on %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(json(body))
    await expect(client().claimedNames({ timeoutMs: 15_000 })).rejects.toThrow()
  })

  it("throws on a body that is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }))
    await expect(client().claimedNames({ timeoutMs: 15_000 })).rejects.toThrow()
  })

  it.each([200, 503])(
    "ends a %i whose body stalls at the deadline with the timeout error",
    async (status) => {
      fetchMock.mockImplementationOnce(stalledBody(status))
      const err = await client()
        .claimedNames({ timeoutMs: 20 })
        .catch((e) => e)
      expect(err).toBeInstanceOf(AccountServiceTimeoutError)
      expect(err.name).not.toBe("AbortError")
      expect(err.name).not.toBe("NotAllowedError")
    },
  )

  it("ends a request with no response at the deadline with the timeout error", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    )
    await expect(client().claimedNames({ timeoutMs: 20 })).rejects.toBeInstanceOf(
      AccountServiceTimeoutError,
    )
  })

  it("sends a request on every call", async () => {
    fetchMock.mockImplementation(async () => json({ nameHashes: [H1] }))
    await client().claimedNames({ timeoutMs: 15_000 })
    await client().claimedNames({ timeoutMs: 15_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("never retries a rejected request", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"))
    await expect(client().claimedNames({ timeoutMs: 15_000 })).rejects.toThrow("network down")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("refuses on a read-only client", async () => {
    const readOnly = new AccountServiceClient("https://as.example.com", { readOnly: true })
    await expect(readOnly.claimedNames({ timeoutMs: 15_000 })).rejects.toBeInstanceOf(
      ReadOnlyClientError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends the synthetic keyId unsigned in test mode", async () => {
    fetchMock.mockResolvedValueOnce(json({ nameHashes: [H1] }))
    const testClient = new AccountServiceClient("https://as.example.com", { testMode: true })
    await testClient.claimedNames({ timeoutMs: 15_000, keyId: "k" })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers[BOOTSTRAP_SIGNATURE_HEADER]).toBeUndefined()
    expect(JSON.parse(init.body).keyId).toBe("k")
  })
})
