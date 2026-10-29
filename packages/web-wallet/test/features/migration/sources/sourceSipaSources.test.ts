import { beforeAll, describe, expect, it, vi } from "vitest"
import { sourceSipaSources } from "../../../../src/features/migration/sourceSipaSources"
import { seedBootConfig } from "../../../support/seedBootConfig"

beforeAll(seedBootConfig)

describe("sourceSipaSources", () => {
  it("finds no SIPAs on a deployment without SIPA implementations", async () => {
    const sipaSources = vi.fn(async () => [])
    await expect(
      sourceSipaSources({
        chain: { kind: "generation", session: { address: "account", sipaSources } as never },
        tuple: { portal: "0xabc", accountMetadataRegistry: "registry" } as never,
        publicClient: {} as never,
        masterSecret: { toString: () => "0x07" } as never,
        scanHead: 42n,
      }),
    ).resolves.toEqual([])
    expect(sipaSources).not.toHaveBeenCalled()
  })
})
