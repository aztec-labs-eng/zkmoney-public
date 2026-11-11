// @vitest-environment node
/** The page's ENS client: present only on a chain with an ENS registry. */
import { describe, expect, it } from "vitest"
import type { PublicClient } from "viem"
import { createPageChain } from "../../src/app/pageChain"
import { resolveBootConfig } from "../../src/config/env"
import { serve, testnetProfile } from "../fixtures/sandboxProfile"
import { sandboxConfig } from "../support/seedBootConfig"
import { testChain } from "../support/query"

describe("ensClient", () => {
  it("is null on a local chain", async () => {
    expect(createPageChain(await sandboxConfig(), testChain()).ensClient()).toBeNull()
  })

  it("is a client of the configured chain on Sepolia", async () => {
    const { config } = await resolveBootConfig({
      env: {
        VITE_NETWORK: "testnet",
        VITE_CONFIG_PROFILE_URL: "https://cdn.zk.money/profiles/v5/current.json",
        VITE_CONFIG_EXPECTED_PROFILE_ID: "staging-v5",
      },
      fetchImpl: serve(testnetProfile()),
    })
    const client = createPageChain(
      config,
      testChain(),
    ).ensClient() as unknown as PublicClient | null
    expect(client?.chain?.id).toBe(11155111)
  })
})
