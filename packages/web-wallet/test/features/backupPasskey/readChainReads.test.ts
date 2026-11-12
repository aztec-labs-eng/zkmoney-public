// @vitest-environment node
/** The entry's chain reads, which need the session's keys. */
import type { ContractService, ObsidionWallet } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import { fixed } from "@obsidion/front-core"
import { readChainReads } from "../../../src/features/backupPasskey/backupPasskeyFacts"
import type { Session } from "../../../src/session/session"

describe("readChainReads", () => {
  it("refuses to read while the session holds no keys, and reads nothing off the wallet", async () => {
    const auth = { sessionKeys: async () => undefined } as unknown as Session["auth"]
    const wallet = { createObsidionAccount: vi.fn() } as unknown as ObsidionWallet
    await expect(
      readChainReads({
        auth,
        page: {} as Session["page"],
        wallet: fixed("wallet", wallet),
        contractService: fixed("contractService", {} as ContractService),
      }),
    ).rejects.toThrow("locked")
    expect(wallet.createObsidionAccount).not.toHaveBeenCalled()
  })
})
