// @vitest-environment node
import type { OxideBridge } from "@obsidion/core/oxide"
import type { ObsidionAccount } from "@obsidion/sdk"
import type { Address } from "viem"
import { describe, expect, it } from "vitest"
import {
  moveFinalizeDeployment,
  shareRescanTokens,
} from "../../../src/features/savings/movesSession"
import { holdingsOf } from "../../support/holdings"

type Page = Parameters<typeof shareRescanTokens>[0]
const ACCOUNT = {} as ObsidionAccount
const bridge = (byte: string): Partial<OxideBridge> => {
  const portal = `0x${byte.repeat(20)}`
  const l2Token = `0x${byte.repeat(32)}`
  return { portal, l2Token, tuple: { portal, l2Token } as OxideBridge["tuple"] }
}
const NEW = bridge("b1")
const OLD = bridge("b2")
const RETIRED_EXECUTOR = `0x${"e1".repeat(20)}` as Address
const PLAIN_EXECUTOR = `0x${"e2".repeat(20)}` as Address
const signer = { address: "0xsigner" }

/** A page whose deployment has `held`'s Sky holdings, and whose executors serve `portals`. */
const page = (held: Partial<OxideBridge>[], portals: Record<string, string> = {}) =>
  ({
    config: { holdings: [] },
    tokenServices: (_account: ObsidionAccount, l2Token: string) => ({
      ready: async () => ({ l2Token }),
    }),
    chain: {
      holdings: { read: async () => holdingsOf(...held) },
      executorPortalAt: (executor: Address) => ({ read: async () => portals[executor] }),
      withdrawalExecutorAt: (address: Address, kind: string) => ({
        read: async () => ({ address, kind }),
      }),
      teeSignerOfToken: async () => signer,
    },
  } as unknown as Page & Parameters<typeof moveFinalizeDeployment>[0]["page"])

describe("shareRescanTokens", () => {
  it("names each Sky holding's share token once, with the deployment a rebuilt burn's finalize runs on", async () => {
    const own = page([NEW, OLD, OLD])
    const tokens = await shareRescanTokens(own, ACCOUNT)
    expect(tokens.map((token) => token.tuple)).toEqual([NEW.tuple, OLD.tuple])
    expect(tokens.map((token) => token.tokenService)).toEqual([
      { l2Token: NEW.l2Token },
      { l2Token: OLD.l2Token },
    ])

    // The rescan stamps a rebuilt burn with its token's portal: the finalize finds its deployment.
    const rebuilt = { deployment: { portal: OLD.portal as Address, l2Token: OLD.l2Token! } }
    expect(await moveFinalizeDeployment({ page: own }, rebuilt)).toEqual({
      tuple: OLD.tuple,
      signer,
    })
  })

  it("reads an executor that serves a held portal as a Sky executor, and any other as plain", async () => {
    const own = page([NEW, OLD], {
      [RETIRED_EXECUTOR]: OLD.portal!,
      [PLAIN_EXECUTOR]: `0x${"aa".repeat(20)}`,
    })
    const [token] = await shareRescanTokens(own, ACCOUNT)
    expect(await token?.readExecutor?.(RETIRED_EXECUTOR)).toMatchObject({ kind: "sky" })
    expect(await token?.readExecutor?.(PLAIN_EXECUTOR)).toMatchObject({ kind: "plain" })
  })
})
