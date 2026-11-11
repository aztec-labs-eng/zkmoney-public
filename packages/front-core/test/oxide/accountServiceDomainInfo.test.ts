// @vitest-environment node
/** The domain info read: an open GET of the service's domain and ticket terms. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { AccountServiceClient, type DomainInfoResponse } from "../../src/oxide/accountServiceClient"

afterEach(() => vi.unstubAllGlobals())

const info: DomainInfoResponse = {
  service: "acct",
  registry: `0x${"11".repeat(20)}`,
  chainId: "1",
  domainOwner: `0x${"22".repeat(20)}`,
  domainOwnerPubKey: `0x${"33".repeat(33)}`,
  goldenTicket: { threshold: "100", schedule: { fee: "1", minDeposit: "5" } },
}

describe("AccountServiceClient.domainInfo", () => {
  it("reads the open route with no credential and returns its body", async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } }),
    )
    vi.stubGlobal("fetch", fetch)
    const client = new AccountServiceClient("https://acct.test", { readOnly: true })
    await expect(client.domainInfo()).resolves.toEqual(info)
    const [url, init] = fetch.mock.calls[0]!
    expect([url, init.method, init.headers]).toEqual([
      "https://acct.test/domain/info",
      "GET",
      undefined,
    ])
  })
})
